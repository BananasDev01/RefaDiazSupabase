import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { serveWithCors } from "../_shared/server.ts";
import { convertToCamelCase } from "../_shared/utils.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!supabaseUrl || !supabaseKey) {
  console.error(
    "Error: Falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en las variables de entorno.",
  );
  Deno.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

const VEHICLE_NOTE_IMAGE_FILE_TYPE_ID = 3;
const VEHICLE_NOTE_SELECT = `
  *,
  car_model:car_model_id(
    id,
    name,
    brand:brand_id(
      id,
      name
    )
  )
`;
const VEHICLE_NOTE_FILE_SELECT = `
  id,
  name,
  mime_type,
  storage_path,
  object_id,
  order_id,
  file_type:file_type_id(id, name),
  active,
  created_at,
  updated_at
`;

type VehicleNoteFileInput = {
  id?: number;
  name: string;
  mimeType: string;
  storagePath: string;
  orderId?: number | null;
  active?: boolean;
};

type VehicleNotePayload = {
  title?: string;
  contentMarkdown?: string;
  carModelId?: number | null;
  files?: VehicleNoteFileInput[];
  active?: boolean;
};

console.log("Edge Function 'vehicle-notes' iniciada...");

function jsonResponse(body: unknown, status: number): Response {
  return new Response(
    JSON.stringify(body),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

function normalizeSearchTerm(value: string | null): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function dedupeById<T extends { id: number }>(rows: T[]): T[] {
  return Array.from(
    new Map(rows.map((row) => [row.id, row])).values(),
  );
}

function sortByCreatedAtDesc<T extends { created_at?: string | null }>(
  rows: T[],
): T[] {
  return [...rows].sort((left, right) => {
    const leftValue = left.created_at ?? "";
    const rightValue = right.created_at ?? "";
    return rightValue.localeCompare(leftValue);
  });
}

function intersectIds(
  left: number[] | undefined,
  right: number[] | undefined,
): number[] | undefined {
  if (!left && !right) {
    return undefined;
  }

  if (!left) {
    return right;
  }

  if (!right) {
    return left;
  }

  const rightSet = new Set(right);
  return left.filter((value) => rightSet.has(value));
}

async function fetchFilesByNoteIds(noteIds: number[]): Promise<any[]> {
  if (noteIds.length === 0) {
    return [];
  }

  const { data, error } = await supabase
    .from("file")
    .select(VEHICLE_NOTE_FILE_SELECT)
    .in("object_id", noteIds)
    .eq("file_type_id", VEHICLE_NOTE_IMAGE_FILE_TYPE_ID)
    .eq("active", true)
    .order("order_id", { ascending: true, nullsFirst: false });

  if (error) {
    throw error;
  }

  return data || [];
}

async function attachFilesToNotes<T extends { id: number }>(
  notes: T[],
): Promise<Array<T & { files: any[] }>> {
  const files = await fetchFilesByNoteIds(notes.map((note) => note.id));

  return notes.map((note) => ({
    ...note,
    files: files.filter((file) => file.object_id === note.id),
  }));
}

async function fetchVehicleNoteById(
  id: string | number,
  includeInactive = false,
): Promise<any | null> {
  let query = supabase
    .from("vehicle_note")
    .select(VEHICLE_NOTE_SELECT)
    .eq("id", id);

  if (!includeInactive) {
    query = query.eq("active", true);
  }

  const { data, error } = await query.maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return null;
  }

  const [noteWithFiles] = await attachFilesToNotes([data]);
  return noteWithFiles;
}

async function fetchModelIdsByBrand(brandId: string): Promise<number[]> {
  const { data, error } = await supabase
    .from("car_model")
    .select("id")
    .eq("brand_id", brandId);

  if (error) {
    throw error;
  }

  return (data || []).map((model) => model.id);
}

async function fetchModelIdsBySearch(term: string): Promise<number[]> {
  const pattern = `%${term}%`;

  const { data: nameMatches, error: modelError } = await supabase
    .from("car_model")
    .select("id")
    .ilike("name", pattern);

  if (modelError) {
    throw modelError;
  }

  const { data: brandMatches, error: brandError } = await supabase
    .from("brand")
    .select("id")
    .ilike("name", pattern);

  if (brandError) {
    throw brandError;
  }

  const brandIds = (brandMatches || []).map((brand) => brand.id);
  let brandModelIds: number[] = [];

  if (brandIds.length > 0) {
    const { data, error } = await supabase
      .from("car_model")
      .select("id")
      .in("brand_id", brandIds);

    if (error) {
      throw error;
    }

    brandModelIds = (data || []).map((model) => model.id);
  }

  return Array.from(
    new Set([
      ...(nameMatches || []).map((model) => model.id),
      ...brandModelIds,
    ]),
  );
}

async function queryVehicleNotes(options: {
  modelIds?: number[];
  titleSearch?: string;
}): Promise<any[]> {
  if (options.modelIds && options.modelIds.length === 0) {
    return [];
  }

  let query = supabase
    .from("vehicle_note")
    .select(VEHICLE_NOTE_SELECT)
    .eq("active", true)
    .order("created_at", { ascending: false });

  if (options.modelIds) {
    query = query.in("car_model_id", options.modelIds);
  }

  if (options.titleSearch) {
    query = query.ilike("title", `%${options.titleSearch}%`);
  }

  const { data, error } = await query;

  if (error) {
    throw error;
  }

  return data || [];
}

async function listVehicleNotes(req: Request): Promise<any[]> {
  const url = new URL(req.url);
  const q = normalizeSearchTerm(url.searchParams.get("q"));
  const brandId = url.searchParams.get("brandId");
  const carModelId = url.searchParams.get("carModelId");

  let scopedModelIds: number[] | undefined;
  const explicitModelIds = carModelId ? [Number(carModelId)] : undefined;
  const brandScopedModelIds = brandId
    ? await fetchModelIdsByBrand(brandId)
    : undefined;

  scopedModelIds = intersectIds(explicitModelIds, brandScopedModelIds);

  if (!carModelId && !brandId) {
    scopedModelIds = undefined;
  }

  if (brandId && (!scopedModelIds || scopedModelIds.length === 0)) {
    return [];
  }

  if (!q) {
    const notes = await queryVehicleNotes({ modelIds: scopedModelIds });
    return await attachFilesToNotes(notes);
  }

  const matchingModelIds = await fetchModelIdsBySearch(q);
  const [titleMatches, modelMatches] = await Promise.all([
    queryVehicleNotes({ modelIds: scopedModelIds, titleSearch: q }),
    queryVehicleNotes({
      modelIds: intersectIds(scopedModelIds, matchingModelIds),
    }),
  ]);

  return sortByCreatedAtDesc(
    await attachFilesToNotes(dedupeById([...titleMatches, ...modelMatches])),
  );
}

async function syncVehicleNoteFiles(
  noteId: number,
  files: VehicleNoteFileInput[],
): Promise<void> {
  const { data: existingFiles, error: fetchError } = await supabase
    .from("file")
    .select("id")
    .eq("object_id", noteId)
    .eq("file_type_id", VEHICLE_NOTE_IMAGE_FILE_TYPE_ID);

  if (fetchError) {
    throw fetchError;
  }

  const existingById = new Set((existingFiles || []).map((file) => file.id));
  const incomingIds = Array.from(
    new Set(
      files
        .map((file) => file.id)
        .filter((id): id is number => typeof id === "number"),
    ),
  );

  for (const incomingId of incomingIds) {
    if (!existingById.has(incomingId)) {
      throw new Error(
        `El archivo con id ${incomingId} no pertenece a la nota ${noteId}`,
      );
    }
  }

  for (const file of files) {
    if (!file.name || !file.mimeType || !file.storagePath) {
      throw new Error(
        "Cada archivo requiere 'name', 'mimeType' y 'storagePath'",
      );
    }

    const payload = {
      name: file.name,
      mime_type: file.mimeType,
      storage_path: file.storagePath,
      object_id: noteId,
      order_id: file.orderId ?? null,
      file_type_id: VEHICLE_NOTE_IMAGE_FILE_TYPE_ID,
      active: file.active ?? true,
    };

    if (typeof file.id === "number") {
      const { error } = await supabase
        .from("file")
        .update(payload)
        .eq("id", file.id);

      if (error) {
        throw error;
      }
    } else {
      const { error } = await supabase
        .from("file")
        .insert(payload);

      if (error) {
        throw error;
      }
    }
  }

  const fileIdsToDelete = (existingFiles || [])
    .map((file) => file.id)
    .filter((id) => !incomingIds.includes(id));

  if (fileIdsToDelete.length > 0) {
    const { error } = await supabase
      .from("file")
      .delete()
      .in("id", fileIdsToDelete);

    if (error) {
      throw error;
    }
  }
}

async function handleGetVehicleNotes(req: Request): Promise<Response> {
  try {
    const notes = await listVehicleNotes(req);
    return jsonResponse(convertToCamelCase(notes), 200);
  } catch (_error) {
    return jsonResponse({ error: "Error al procesar la solicitud" }, 400);
  }
}

async function handleGetVehicleNoteById(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");

    if (!id) {
      return jsonResponse(
        { error: "Falta el parámetro 'id' en la URL" },
        400,
      );
    }

    const note = await fetchVehicleNoteById(id);

    if (!note) {
      return jsonResponse({ error: "La nota no existe" }, 404);
    }

    return jsonResponse(convertToCamelCase(note), 200);
  } catch (_error) {
    return jsonResponse({ error: "Error al procesar la solicitud" }, 400);
  }
}

async function handlePostVehicleNote(req: Request): Promise<Response> {
  let createdNoteId: number | null = null;

  try {
    const contentType = req.headers.get("content-type");
    if (!contentType || !contentType.includes("application/json")) {
      return jsonResponse(
        { error: "El Content-Type debe ser application/json" },
        400,
      );
    }

    const body = await req.json() as VehicleNotePayload;

    if (!body.title || !body.contentMarkdown) {
      return jsonResponse(
        {
          error: "Los campos 'title' y 'contentMarkdown' son obligatorios",
        },
        400,
      );
    }

    const { data, error } = await supabase
      .from("vehicle_note")
      .insert({
        title: body.title,
        content_markdown: body.contentMarkdown,
        car_model_id: body.carModelId ?? null,
        active: body.active ?? true,
      })
      .select("id")
      .single();

    if (error) {
      return jsonResponse({ error: error.message }, 500);
    }

    const noteId = data.id as number;
    createdNoteId = noteId;

    if (body.files) {
      await syncVehicleNoteFiles(noteId, body.files);
    }

    const note = await fetchVehicleNoteById(noteId, true);
    return jsonResponse(convertToCamelCase(note), 201);
  } catch (error) {
    if (createdNoteId !== null) {
      await supabase
        .from("file")
        .delete()
        .eq("object_id", createdNoteId)
        .eq("file_type_id", VEHICLE_NOTE_IMAGE_FILE_TYPE_ID);

      await supabase
        .from("vehicle_note")
        .delete()
        .eq("id", createdNoteId);
    }

    const message = error instanceof Error
      ? error.message
      : "Payload JSON inválido";

    return jsonResponse({ error: message }, 400);
  }
}

async function handlePutVehicleNote(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");

    if (!id) {
      return jsonResponse(
        { error: "Falta el parámetro 'id' en la URL" },
        400,
      );
    }

    const contentType = req.headers.get("content-type");
    if (!contentType || !contentType.includes("application/json")) {
      return jsonResponse(
        { error: "El Content-Type debe ser application/json" },
        400,
      );
    }

    const body = await req.json() as VehicleNotePayload;
    const updatePayload: Record<string, unknown> = {};

    if ("title" in body) {
      updatePayload.title = body.title;
    }

    if ("contentMarkdown" in body) {
      updatePayload.content_markdown = body.contentMarkdown;
    }

    if ("carModelId" in body) {
      updatePayload.car_model_id = body.carModelId ?? null;
    }

    if ("active" in body) {
      updatePayload.active = body.active;
    }

    if (Object.keys(updatePayload).length > 0) {
      const { data, error } = await supabase
        .from("vehicle_note")
        .update(updatePayload)
        .eq("id", id)
        .select("id")
        .maybeSingle();

      if (error) {
        return jsonResponse({ error: error.message }, 500);
      }

      if (!data) {
        return jsonResponse({ error: "La nota no existe" }, 404);
      }
    } else {
      const existingNote = await fetchVehicleNoteById(id, true);

      if (!existingNote) {
        return jsonResponse({ error: "La nota no existe" }, 404);
      }
    }

    if ("files" in body) {
      await syncVehicleNoteFiles(Number(id), body.files || []);
    }

    const note = await fetchVehicleNoteById(id, true);
    return jsonResponse(convertToCamelCase(note), 200);
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "Payload JSON inválido";

    return jsonResponse({ error: message }, 400);
  }
}

async function handleDeleteVehicleNote(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");

    if (!id) {
      return jsonResponse(
        { error: "Falta el parámetro 'id' en la URL" },
        400,
      );
    }

    const { data, error } = await supabase
      .from("vehicle_note")
      .update({ active: false })
      .eq("id", id)
      .select("id")
      .maybeSingle();

    if (error) {
      return jsonResponse({ error: error.message }, 500);
    }

    if (!data) {
      return jsonResponse({ error: "La nota no existe" }, 404);
    }

    const note = await fetchVehicleNoteById(id, true);
    return jsonResponse(convertToCamelCase(note), 200);
  } catch (_error) {
    return jsonResponse({ error: "Error al procesar la solicitud" }, 400);
  }
}

serveWithCors(async (req: Request) => {
  if (req.method === "GET") {
    const url = new URL(req.url);

    if (url.searchParams.get("id")) {
      return await handleGetVehicleNoteById(req);
    }

    return await handleGetVehicleNotes(req);
  }

  switch (req.method) {
    case "POST":
      return await handlePostVehicleNote(req);
    case "PUT":
      return await handlePutVehicleNote(req);
    case "DELETE":
      return await handleDeleteVehicleNote(req);
    default:
      return jsonResponse({ error: "Método no permitido" }, 405);
  }
});
