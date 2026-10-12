import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { serveWithCors } from '../_shared/server.ts';
import { handleDocumentsRequest } from './handler.ts';
const url = Deno.env.get('SUPABASE_URL');
const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
if(!url || !key) throw new Error('Missing Supabase configuration');
const db = createClient(url,key);
serveWithCors(req=>handleDocumentsRequest(req,db));
