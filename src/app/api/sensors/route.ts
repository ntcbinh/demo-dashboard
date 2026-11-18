import {
  buildSensorCatalog,
  toCatalogPayload,
  type SensorCatalogPayload,
} from "@/lib/sensors";

/**
 * The sensor catalog — static metadata for all 5,000 sensors.
 *
 * Returned in columnar form (parallel arrays rather than an array of objects),
 * which removes the repeated key names from the payload and cuts it to roughly
 * a quarter of the size. The client turns it back into row objects once.
 */

/**
 * The catalog is deterministic, so generating it is cached rather than redone
 * per request. `use cache` wraps the plain payload, not the `Response` — a
 * Response body is a stream and cannot be replayed from a cache.
 */
async function getCatalog(): Promise<SensorCatalogPayload> {
  "use cache";
  return toCatalogPayload(buildSensorCatalog());
}

export async function GET(): Promise<Response> {
  const payload = await getCatalog();

  return Response.json(payload, {
    headers: {
      "cache-control": "public, max-age=3600",
    },
  });
}
