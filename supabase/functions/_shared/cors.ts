export const corsHeaders = {
    'Access-Control-Allow-Origin': '*', // Cambia '*' por un dominio específico si prefieres restringirlo
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, x-client-info, apikey',
  };
  
  export const handleCors = (req: Request): Response | null => {
    if (req.method === 'OPTIONS') {
      return new Response('ok', { headers: corsHeaders, status: 200 });
    }
    return null;
  };
