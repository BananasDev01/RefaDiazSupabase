// Importa las definiciones de tipos y la API del runtime de Supabase
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Importa el cliente de Supabase desde esm.sh
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { serveWithCors } from "../_shared/server.ts";
import { convertToCamelCase, convertToSnakeCase } from "../_shared/utils.ts";

// Obtén las variables de entorno necesarias para la conexión
const supabaseUrl = Deno.env.get("SUPABASE_URL");
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!supabaseUrl || !supabaseKey) {
  console.error("Error: Falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en las variables de entorno.");
  Deno.exit(1);
}

// Inicializa el cliente de Supabase
const supabase = createClient(supabaseUrl, supabaseKey);

console.log("Edge Function 'brands' iniciada...");

// Constante para el file_type_id de imágenes de marcas (basado en tu scriptBrands.sql)
const BRAND_IMAGE_FILE_TYPE_ID = 1;

/**
 * GET /brands
 * Retorna todos los registros de la tabla "brand" con su "file" relacionado si existe.
 */
async function handleGetBrands(req: Request): Promise<Response> {
  const { data: brands, error: brandError } = await supabase
    .from("brand")
    .select("*")
    .eq("active", true)
    .order("name", { ascending: true });

  if (brandError) {
    return new Response(
      JSON.stringify({ error: brandError.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  const brandIds = brands.map((brand) => brand.id);
  const { data: files, error: fileError } = await supabase
    .from("file")
    .select("*")
    .in("object_id", brandIds)
    .eq("file_type_id", BRAND_IMAGE_FILE_TYPE_ID);

  if (fileError) {
    return new Response(
      JSON.stringify({ error: fileError.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  const result = brands.map((brand) => ({
    ...brand,
    file: files.find((file) => file.object_id === brand.id) || null,
  }));

  const camelCaseResult = convertToCamelCase(result);
  return new Response(
    JSON.stringify(camelCaseResult),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

/**
 * GET /brands?id=<ID>
 * Retorna una marca específica de la tabla "brand" con su "file" relacionado si existe.
 */
async function handleGetBrandById(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");

    if (!id) {
      return new Response(
        JSON.stringify({ error: "Falta el parámetro 'id' en la URL" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const { data: brand, error: brandError } = await supabase
      .from("brand")
      .select("*")
      .eq("id", id)
      .eq("active", true)
      .single();

    if (brandError) {
      return new Response(
        JSON.stringify({ error: brandError.message }),
        { 
          status: brandError.code === "PGRST116" ? 404 : 500,
          headers: { "Content-Type": "application/json" } 
        }
      );
    }

    const { data: file, error: fileError } = await supabase
      .from("file")
      .select("*")
      .eq("object_id", id)
      .eq("file_type_id", BRAND_IMAGE_FILE_TYPE_ID)
      .maybeSingle();

    if (fileError) {
      return new Response(
        JSON.stringify({ error: fileError.message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const result = { ...brand, file: file || null };
    const camelCaseResult = convertToCamelCase(result);
    return new Response(
      JSON.stringify(camelCaseResult),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Error al procesar la solicitud" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
}

/**
 * GET /brands?id=<brandId>&models=true
 * Retorna todos los modelos asociados a una marca específica ("car_model") con búsqueda opcional por nombre.
 */
async function handleGetBrandModels(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const brandId = url.searchParams.get("id");
    const name = url.searchParams.get("name");

    if (!brandId) {
      return new Response(
        JSON.stringify({ error: "Falta el parámetro 'id' en la URL" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Verificar que la marca existe y está activa
    const { data: brand, error: brandError } = await supabase
      .from("brand")
      .select("*")
      .eq("id", brandId)
      .eq("active", true)
      .single();

    if (brandError) {
      return new Response(
        JSON.stringify({ error: brandError.message }),
        { 
          status: brandError.code === "PGRST116" ? 404 : 500,
          headers: { "Content-Type": "application/json" } 
        }
      );
    }

    let query = supabase
      .from("car_model")
      .select("*")
      .eq("brand_id", brandId)
      .eq("active", true)
      .order("name", { ascending: true });

    if (name) {
      query = query.ilike("name", `%${name}%`);
    }

    const { data: models, error: modelsError } = await query;

    if (modelsError) {
      return new Response(
        JSON.stringify({ error: modelsError.message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const modelsWithBrand = models.map(model => ({
      ...model,
      brand: brand
    }));

    const camelCaseModels = convertToCamelCase(modelsWithBrand);
    return new Response(
      JSON.stringify(camelCaseModels),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Error al procesar la solicitud" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
}

/**
 * POST /brands
 * Crea una nueva marca en la tabla "brand" con su registro en "file" usando la URL proporcionada por el cliente.
 */
async function handlePostBrand(req: Request): Promise<Response> {
  try {
    const contentType = req.headers.get("content-type");
    if (!contentType || !contentType.includes("application/json")) {
      return new Response(
        JSON.stringify({ error: "El Content-Type debe ser application/json" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const camelCaseBody = await req.json();
    const body = convertToSnakeCase(camelCaseBody);
    
    const { name, brand_type_id, active, file } = body;

    if (!name || !brand_type_id) {
      return new Response(
        JSON.stringify({ error: "Faltan campos obligatorios: name o brand_type_id" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const { data: brandData, error: brandError } = await supabase
      .from("brand")
      .insert({ name, brand_type_id, active: active ?? true })
      .select("*")
      .single();

    if (brandError) {
      return new Response(
        JSON.stringify({ error: brandError.message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    let fileData = null;
    if (file && file.storage_path) {
      const filePayload = {
        name: file.name,
        mime_type: file.mime_type,
        storage_path: file.storage_path,
        object_id: brandData.id,
        file_type_id: BRAND_IMAGE_FILE_TYPE_ID,
        active: true,
      };

      const { data: fileResult, error: fileError } = await supabase
        .from("file")
        .insert(filePayload)
        .select("*")
        .single();

      if (fileError) {
        await supabase.from("brand").delete().eq("id", brandData.id);
        return new Response(
          JSON.stringify({ error: fileError.message }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
      fileData = fileResult;
    }

    const responseData = { ...brandData, file: fileData };
    const camelCaseResponseData = convertToCamelCase(responseData);
    return new Response(
      JSON.stringify(camelCaseResponseData),
      { status: 201, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Payload JSON inválido o error inesperado" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
}

/**
 * PUT /brands?id=<ID>
 * Actualiza una marca existente en la tabla "brand" y su registro en "file".
 */
async function handlePutBrand(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");

    if (!id) {
      return new Response(
        JSON.stringify({ error: "Falta el parámetro 'id' en la URL" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const contentType = req.headers.get("content-type");
    if (!contentType || !contentType.includes("application/json")) {
      return new Response(
        JSON.stringify({ error: "El Content-Type debe ser application/json" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const camelCaseBody = await req.json();
    const body = convertToSnakeCase(camelCaseBody);
    
    const { name, brand_type_id, active, file } = body;

    const { data: brandData, error: brandError } = await supabase
      .from("brand")
      .update({ name, brand_type_id, active })
      .eq("id", id)
      .select("*")
      .single();

    if (brandError) {
      return new Response(
        JSON.stringify({ error: brandError.message }),
        { 
          status: brandError.code === "PGRST116" ? 404 : 500,
          headers: { "Content-Type": "application/json" } 
        }
      );
    }

    let fileData = null;
    if (file && file.storage_path) {
      const { data: existingFile, error: fetchFileError } = await supabase
        .from("file")
        .select("*")
        .eq("object_id", id)
        .eq("file_type_id", BRAND_IMAGE_FILE_TYPE_ID)
        .maybeSingle();

      if (fetchFileError) {
        return new Response(
          JSON.stringify({ error: fetchFileError.message }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }

      if (existingFile) {
        const { data: updatedFile, error: updateError } = await supabase
          .from("file")
          .update({
            name: file.name,
            mime_type: file.mime_type,
            storage_path: file.storage_path,
          })
          .eq("id", existingFile.id)
          .select("*")
          .single();

        if (updateError) {
          return new Response(
            JSON.stringify({ error: updateError.message }),
            { status: 500, headers: { "Content-Type": "application/json" } }
          );
        }
        fileData = updatedFile;
      } else {
        const filePayload = {
          name: file.name,
          mime_type: file.mime_type,
          storage_path: file.storage_path,
          object_id: id,
          file_type_id: BRAND_IMAGE_FILE_TYPE_ID,
          active: true,
        };

        const { data: newFile, error: createError } = await supabase
          .from("file")
          .insert(filePayload)
          .select("*")
          .single();

        if (createError) {
          return new Response(
            JSON.stringify({ error: createError.message }),
            { status: 500, headers: { "Content-Type": "application/json" } }
          );
        }
        fileData = newFile;
      }
    }

    const responseData = { ...brandData, file: fileData };
    const camelCaseResponseData = convertToCamelCase(responseData);
    return new Response(
      JSON.stringify(camelCaseResponseData),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Payload JSON inválido o error inesperado" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
}

/**
 * DELETE /brands?id=<ID>
 * Elimina una marca de la tabla "brand" y su archivo relacionado si existe.
 */
async function handleDeleteBrand(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");

    if (!id) {
      return new Response(
        JSON.stringify({ error: "Falta el parámetro 'id' en la URL" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const { data: brandData, error: brandError } = await supabase
      .from("brand")
      .select("*")
      .eq("id", id)
      .single();

    if (brandError) {
      return new Response(
        JSON.stringify({ error: brandError.message }),
        { 
          status: brandError.code === "PGRST116" ? 404 : 500,
          headers: { "Content-Type": "application/json" } 
        }
      );
    }

    const { data: fileData, error: fileError } = await supabase
      .from("file")
      .select("*")
      .eq("object_id", id)
      .eq("file_type_id", BRAND_IMAGE_FILE_TYPE_ID)
      .maybeSingle();

    if (fileError) {
      return new Response(
        JSON.stringify({ error: fileError.message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    if (fileData) {
      const { error: deleteFileError } = await supabase
        .from("file")
        .delete()
        .eq("id", fileData.id);

      if (deleteFileError) {
        return new Response(
          JSON.stringify({ error: deleteFileError.message }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    const { error: deleteBrandError } = await supabase
      .from("brand")
      .delete()
      .eq("id", id);

    if (deleteBrandError) {
      return new Response(
        JSON.stringify({ error: deleteBrandError.message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const result = { ...brandData, file: fileData || null };
    const camelCaseResult = convertToCamelCase(result);
    return new Response(
      JSON.stringify(camelCaseResult),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Error al procesar la solicitud" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
}

// Función principal que enruta la petición según el método HTTP
serveWithCors(async (req: Request) => {
  if (req.method === "GET") {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    const fetchModels = url.searchParams.get("models") === "true";

    if (id && fetchModels) {
      return await handleGetBrandModels(req);
    } else if (id) {
      return await handleGetBrandById(req);
    } else {
      return await handleGetBrands(req);
    }
  }
  
  switch (req.method) {
    case "POST":
      return await handlePostBrand(req);
    case "PUT":
      return await handlePutBrand(req);
    case "DELETE":
      return await handleDeleteBrand(req);
    default:
      return new Response(
        JSON.stringify({ error: "Método no permitido" }),
        { status: 405, headers: { "Content-Type": "application/json" } }
      );
  }
});
