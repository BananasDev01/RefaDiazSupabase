import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { handleDocumentsRequest } from './handler.ts';
const db = {} as SupabaseClient;
const assert=(value:unknown)=>{if(!value)throw new Error('Assertion failed');};
const base='http://localhost/functions/v1/service-documents';
Deno.test('staff routes require authentication before accessing database',async()=>{
  for(const [path,method] of [['','GET'],['/sessions','POST'],['/00000000-0000-4000-8000-000000000001/url','GET'],['/sessions/00000000-0000-4000-8000-000000000001/revoke','POST']]) {
    const response=await handleDocumentsRequest(new Request(base+path,{method}),db);
    assert(response.status===401);await response.text();
  }
});
Deno.test('public metadata rejects invalid tokens without revealing order details',async()=>{
  const response=await handleDocumentsRequest(new Request(base+'/session',{method:'POST',body:JSON.stringify({token:'known-order-id'})}),db);
  assert(response.status===410);assert(!(await response.text()).includes('folio'));
});
Deno.test('upload rejects disguised SVG despite image/jpeg MIME',async()=>{
  const form=new FormData();form.append('token','a'.repeat(64));form.append('file',new File(['<svg onload="alert(1)"></svg>'],'photo.jpg',{type:'image/jpeg'}));
  const response=await handleDocumentsRequest(new Request(base+'/upload',{method:'POST',body:form}),db);
  assert(response.status===400);await response.text();
});
Deno.test('invalid upload token cannot target an order',async()=>{
  const form=new FormData();form.append('token','123');form.append('serviceId','1');form.append('file',new File(['%PDF-1.7 example'],'photo.pdf',{type:'application/pdf'}));
  const response=await handleDocumentsRequest(new Request(base+'/upload',{method:'POST',body:form}),db);
  assert(response.status===410);await response.text();
});
