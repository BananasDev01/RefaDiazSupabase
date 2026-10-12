import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { requireAppRole } from '../_shared/auth.ts';
import { isUuid, jsonResponse, rpcErrorResponse } from '../_shared/api.ts';
import { detectDocumentMime, limitedBody, MAX_FILE_BYTES, sha256, tokenIsValid } from './validation.ts';
import { convertToCamelCase } from '../_shared/utils.ts';

const BUCKET = 'service-documents';
const documentColumns = 'external_id,service_version,folio_snapshot,mime_type,byte_size,created_at,document_version';
const invalidToken = () => jsonResponse({ error: 'El enlace venció o ya no está disponible. Genera otro QR.' }, 410);

export async function handleDocumentsRequest(req: Request, db: SupabaseClient): Promise<Response> {
  const parts = new URL(req.url).pathname.split('/').filter(Boolean);
  const route = parts.slice(parts.lastIndexOf('service-documents') + 1);
  try {
    // These two routes use a narrowly scoped upload capability, not an app login.
    if (req.method==='POST' && route.length===1 && route[0]==='session') {
      const body = JSON.parse(new TextDecoder().decode(await limitedBody(req,4096)));
      if (!tokenIsValid(body.token)) return invalidToken();
      const { data, error } = await db.from('service_upload_session').select('expires_at,state,service_version,document_snapshot')
        .eq('token_hash',await sha256(body.token)).maybeSingle();
      if (error || !data || data.state==='REVOKED' || Date.parse(data.expires_at)<=Date.now()) return invalidToken();
      return jsonResponse({ expiresAt:data.expires_at, status:data.state, serviceVersion:data.service_version,
        folio:String(data.document_snapshot.folio_number ?? data.document_snapshot.provisional_reference) });
    }
    if (req.method==='POST' && route.length===1 && route[0]==='upload') return await upload(req,db);

    const auth = await requireAppRole(req,db,['ADMINISTRADOR','EMPLEADO']);
    if (auth instanceof Response) return auth;
    if (req.method==='POST' && route.length===1 && route[0]==='sessions') {
      const body = JSON.parse(new TextDecoder().decode(await limitedBody(req,4096)));
      if (!isUuid(body.serviceExternalId) || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion<1)
        return jsonResponse({ error:'Orden o versión inválida' },400);
      const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), n=>n.toString(16).padStart(2,'0')).join('');
      const { data,error } = await db.rpc('create_service_upload_session_v1',{
        p_external_id:body.serviceExternalId,p_expected_version:body.expectedVersion,p_token_hash:await sha256(token),p_actor:auth.userId,
      });
      if (error) return rpcErrorResponse(error);
      return jsonResponse({ ...data,token },201);
    }
    if (req.method==='POST' && route.length===3 && route[0]==='sessions' && isUuid(route[1]) && route[2]==='revoke') {
      const { error } = await db.from('service_upload_session').update({state:'REVOKED'}).eq('id',route[1]).in('state',['READY','UPLOADING']);
      return error ? rpcErrorResponse(error) : jsonResponse({ok:true});
    }
    if (req.method==='GET' && route.length===0) {
      const externalId = new URL(req.url).searchParams.get('serviceExternalId');
      if (!isUuid(externalId)) return jsonResponse({error:'Orden inválida'},400);
      const { data:service,error:serviceError } = await db.from('service').select('id').eq('external_id',externalId).maybeSingle();
      if (serviceError) return rpcErrorResponse(serviceError);
      if (!service) return jsonResponse({error:'Orden no encontrada'},404);
      const { data,error } = await db.from('service_document').select(documentColumns).eq('service_id',service.id)
        .eq('document_kind','SIGNED_SCAN').order('created_at',{ascending:false});
      return error ? rpcErrorResponse(error) : jsonResponse(convertToCamelCase(data));
    }
    if (req.method==='GET' && route.length===2 && isUuid(route[0]) && route[1]==='url') {
      const {data,error} = await db.from('service_document').select('storage_object_path,mime_type').eq('external_id',route[0]).eq('document_kind','SIGNED_SCAN').maybeSingle();
      if(error) return rpcErrorResponse(error);
      if(!data) return jsonResponse({error:'Documento no encontrado'},404);
      const result = await db.storage.from(BUCKET).createSignedUrl(data.storage_object_path,300);
      if(result.error) return jsonResponse({error:'No se pudo abrir el documento'},500);
      const signedUrl = new URL(result.data.signedUrl);
      // Do not expose the internal Kong origin from the Edge runtime.
      return jsonResponse({url:signedUrl.pathname+signedUrl.search,mimeType:data.mime_type});
    }
    return jsonResponse({error:'Ruta no encontrada'},404);
  } catch (error) {
    return jsonResponse({error: error instanceof Error && error.message==='FILE_TOO_LARGE'
      ? 'El archivo supera el límite de 10 MB.' : 'No se pudo procesar la solicitud.'},400);
  }
}

async function upload(req: Request, db: SupabaseClient): Promise<Response> {
  const bytes = await limitedBody(req,MAX_FILE_BYTES+65536);
  const form = await new Response(bytes,{headers:{'content-type':req.headers.get('content-type') ?? ''}}).formData();
  const token = form.get('token'); const file = form.get('file');
  if (!tokenIsValid(token)) return invalidToken();
  if (!(file instanceof File)) return jsonResponse({error:'Selecciona una foto o PDF'},400);
  const content = new Uint8Array(await file.arrayBuffer());
  const mime = detectDocumentMime(content);
  if(!mime) return jsonResponse({error:'Usa una imagen JPG/PNG o un PDF válido de hasta 10 MB.'},400);
  const hash = await sha256(token); const checksum = await sha256(content);
  const claimed = await db.rpc('claim_service_upload_v1',{p_token_hash:hash});
  if(claimed.error) return rpcErrorResponse(claimed.error);
  const claim = claimed.data;
  if(claim.completed) return claim.sha256===checksum ? jsonResponse({documentId:claim.documentId})
    : jsonResponse({error:'Este enlace ya se utilizó. Genera otro QR para otro documento.'},409);
  let stored = false;
  try {
    const result = await db.storage.from(BUCKET).upload(claim.path,content,{contentType:mime,upsert:false});
    if(result.error) throw new Error('STORAGE_FAILED');
    stored = true;
    const finished = await db.rpc('finish_service_upload_v1',{
      p_token_hash:hash,p_lease_id:claim.leaseId,p_path:claim.path,p_mime:mime,p_size:content.byteLength,p_sha256:checksum,
    });
    if(finished.error) throw new Error('FINALIZE_FAILED');
    return jsonResponse(finished.data,201);
  } catch {
    // Never remove a successfully registered immutable document after an ambiguous
    // network response. A retry with the same token/checksum returns its document.
    const check = await db.from('service_upload_session').select('state,document_id').eq('token_hash',hash).single();
    if(!check.error && check.data?.state==='COMPLETED') return jsonResponse({ok:true});
    if(!check.error) {
      if(stored) await db.storage.from(BUCKET).remove([claim.path]);
      await db.from('service_upload_session').update({state:'READY',lease_until:null}).eq('token_hash',hash).eq('lease_id',claim.leaseId).eq('state','UPLOADING');
    }
    return jsonResponse({error:'La carga no se completó. Puedes volver a intentarlo con este enlace.'},503);
  }
}
