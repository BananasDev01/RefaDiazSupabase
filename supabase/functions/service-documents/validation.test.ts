import { detectDocumentMime,limitedBody,MAX_FILE_BYTES,sha256,tokenIsValid } from './validation.ts';
const assert=(value:unknown)=>{if(!value) throw new Error('Assertion failed');};
Deno.test('detects allowed magic bytes, not client extension or HTML/SVG',()=>{
  assert(detectDocumentMime(new TextEncoder().encode('%PDF-1.7 sample'))==='application/pdf');
  assert(detectDocumentMime(new Uint8Array([137,80,78,71,13,10,26,10]))==='image/png');
  assert(detectDocumentMime(new Uint8Array([255,216,255,224,0,0,0,0]))==='image/jpeg');
  assert(detectDocumentMime(new TextEncoder().encode('<svg onload="alert(1)">'))===null);
  assert(detectDocumentMime(new Uint8Array(MAX_FILE_BYTES+1))===null);
});
Deno.test('capabilities require 256-bit random hex and hash consistently',async()=>{
  assert(tokenIsValid('a'.repeat(64))); assert(!tokenIsValid('known-order-id'));assert(!tokenIsValid(null));
  assert((await sha256('abc'))==='ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
Deno.test('body limits apply even without Content-Length',async()=>{
  let rejected=false;try{await limitedBody(new Request('https://local/upload',{method:'POST',body:'123456'}),5);}catch{rejected=true;}
  assert(rejected);
  assert((await limitedBody(new Request('https://local/upload',{method:'POST',body:'1234'}),5)).length===4);
});
