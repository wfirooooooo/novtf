import type { DatabaseSync } from "node:sqlite";
import {
  builtinSnapshot,
  isConfig,
  isLabel,
  isPlatformId,
  isRegionId,
  isServiceId,
  isZoneId,
  type CatalogSnapshot,
} from "./catalog.ts";

export function ensureCatalog(db: DatabaseSync): void {
  const snapshot = builtinSnapshot();
  const now = new Date().toISOString();
  const insertPlatform = db.prepare(
    "INSERT OR IGNORE INTO catalog_platform (id, label, enabled, created_at) VALUES (?, ?, 1, ?)",
  );
  for (const platform of snapshot.platforms) insertPlatform.run(platform.id, platform.label, now);
  prefixStoredServiceIds(db);
  const insertService = db.prepare(
    `INSERT OR IGNORE INTO catalog_service (platform_id, id, label, group_name, network, enabled, summary, config)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const service of snapshot.services) {
    insertService.run(
      service.platformId,
      service.id,
      service.label,
      service.group,
      service.network,
      service.enabled ? 1 : 0,
      service.summary,
      service.config,
    );
  }
  const fillConfig = db.prepare(
    "UPDATE catalog_service SET config = ? WHERE platform_id = ? AND id = ? AND trim(config) = ''",
  );
  for (const service of snapshot.services) fillConfig.run(service.config, service.platformId, service.id);
  const insertRegion = db.prepare("INSERT OR IGNORE INTO catalog_region (platform_id, id, label) VALUES (?, ?, ?)");
  for (const region of snapshot.regions) insertRegion.run(region.platformId, region.id, region.label);
}

export function loadCatalog(db: DatabaseSync): CatalogSnapshot {
  const platforms = db
    .prepare("SELECT id, label, enabled FROM catalog_platform ORDER BY created_at, rowid")
    .all() as Array<{ id: string; label: string; enabled: number }>;
  const services = db
    .prepare(
      "SELECT platform_id, id, label, group_name, network, enabled, summary, config FROM catalog_service ORDER BY platform_id, rowid",
    )
    .all() as Array<{
    platform_id: string;
    id: string;
    label: string;
    group_name: string;
    network: "required" | "optional";
    enabled: number;
    summary: string;
    config: string;
  }>;
  const regions = db
    .prepare("SELECT platform_id, id, label FROM catalog_region ORDER BY platform_id, rowid")
    .all() as Array<{ platform_id: string; id: string; label: string }>;
  const zones = db
    .prepare("SELECT platform_id, region_id, id, label FROM catalog_zone ORDER BY platform_id, region_id, rowid")
    .all() as Array<{ platform_id: string; region_id: string; id: string; label: string }>;
  return {
    platforms: platforms.map((platform) => ({ id: platform.id, label: platform.label, enabled: platform.enabled === 1 })),
    services: services.map((service) => ({
      platformId: service.platform_id,
      id: service.id,
      label: service.label,
      group: service.group_name,
      network: service.network,
      enabled: service.enabled === 1,
      summary: service.summary,
      config: service.config,
    })),
    regions: regions.map((region) => ({ platformId: region.platform_id, id: region.id, label: region.label })),
    zones: zones.map((zone) => ({
      platformId: zone.platform_id,
      regionId: zone.region_id,
      id: zone.id,
      label: zone.label,
    })),
  };
}

export interface CatalogNotice {
  code: string;
  value: string;
}

export function addPlatform(db: DatabaseSync, id: string, label: string): CatalogNotice | null {
  const platformId = id.trim().toLowerCase();
  const name = label.trim();
  if (!isPlatformId(platformId) || !isLabel(name)) return { code: "bad_id", value: id.trim() };
  const existing = db.prepare("SELECT id FROM catalog_platform WHERE id = ?").get(platformId) as { id: string } | undefined;
  if (existing) return { code: "platform_exists", value: platformId };
  const sameLabel = db.prepare("SELECT id FROM catalog_platform WHERE lower(label) = lower(?)").get(name) as
    | { id: string }
    | undefined;
  if (sameLabel) return { code: "platform_label_exists", value: name };
  db.prepare("INSERT INTO catalog_platform (id, label, enabled, created_at) VALUES (?, ?, 1, ?)").run(
    platformId,
    name,
    new Date().toISOString(),
  );
  return null;
}

export function prefixStoredServiceIds(db: DatabaseSync): void {
  const platformIds = (db.prepare("SELECT id FROM catalog_platform").all() as Array<{ id: string }>).map((row) => row.id);
  const services = db.prepare("SELECT platform_id, id FROM catalog_service").all() as Array<{
    platform_id: string;
    id: string;
  }>;
  const renames = services.flatMap((row) => {
    const next = serviceIdentifier(row.platform_id, row.id, platformIds);
    return next && next !== row.id && isServiceId(next) ? [{ platform: row.platform_id, from: row.id, to: next }] : [];
  });
  const selections = db.prepare("SELECT stack_id, platform, services, parameters FROM stack_selection").all() as Array<{
    stack_id: string;
    platform: string;
    services: string;
    parameters: string;
  }>;
  const selectionWrites = selections.flatMap((row) => {
    const servicesJson = rewriteServiceList(row.platform, row.services, platformIds);
    const parametersJson = rewriteParameters(row.platform, row.parameters, platformIds);
    return servicesJson || parametersJson
      ? [{ stackId: row.stack_id, platform: row.platform, services: servicesJson, parameters: parametersJson }]
      : [];
  });
  const records = db.prepare("SELECT stack_id, platform, region, address, service FROM service_record").all() as Array<{
    stack_id: string;
    platform: string;
    region: string;
    address: string;
    service: string;
  }>;
  const recordWrites = records.flatMap((row) => {
    const next = serviceIdentifier(row.platform, row.service, platformIds);
    return next && next !== row.service && isServiceId(next) ? [{ ...row, to: next }] : [];
  });
  if (renames.length === 0 && selectionWrites.length === 0 && recordWrites.length === 0) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    const exists = db.prepare("SELECT id FROM catalog_service WHERE platform_id = ? AND id = ?");
    const remove = db.prepare("DELETE FROM catalog_service WHERE platform_id = ? AND id = ?");
    const rename = db.prepare("UPDATE catalog_service SET id = ? WHERE platform_id = ? AND id = ?");
    for (const change of renames) {
      if (exists.get(change.platform, change.to)) remove.run(change.platform, change.from);
      else rename.run(change.to, change.platform, change.from);
    }
    const writeSelection = db.prepare(
      "UPDATE stack_selection SET services = COALESCE(?, services), parameters = COALESCE(?, parameters) WHERE stack_id = ? AND platform = ?",
    );
    for (const row of selectionWrites) writeSelection.run(row.services, row.parameters, row.stackId, row.platform);
    const writeRecord = db.prepare(
      "UPDATE service_record SET service = ? WHERE stack_id = ? AND platform = ? AND region = ? AND address = ?",
    );
    for (const row of recordWrites) writeRecord.run(row.to, row.stack_id, row.platform, row.region, row.address);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function rewriteServiceList(platform: string, raw: string, platformIds: readonly string[]): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  let changed = false;
  const next = parsed.map((item) => {
    const id = String(item);
    const prefixed = serviceIdentifier(platform, id, platformIds) || id;
    if (prefixed !== id) changed = true;
    return prefixed;
  });
  return changed ? JSON.stringify(next) : null;
}

function rewriteParameters(platform: string, raw: string, platformIds: readonly string[]): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const prefixed = serviceIdentifier(platform, key, platformIds) || key;
    if (prefixed !== key) changed = true;
    next[prefixed] = value;
  }
  return changed ? JSON.stringify(next) : null;
}

export function serviceIdentifier(platform: string, raw: string, platformIds: readonly string[]): string {
  let body = raw.trim().toLowerCase();
  const own = `${platform}_`;
  if (body.startsWith(own)) body = body.slice(own.length);
  else {
    const head = body.split("_")[0] ?? "";
    if (head && platformIds.includes(head) && body.startsWith(`${head}_`)) body = body.slice(head.length + 1);
  }
  return body ? `${platform}_${body}` : "";
}

export function addService(
  db: DatabaseSync,
  platformId: string,
  id: string,
  label: string,
  group: string,
  network: string,
  config: string,
): CatalogNotice | null {
  const platform = platformId.trim().toLowerCase();
  const name = label.trim();
  const groupName = group.trim() || "其他";
  const platformIds = (db.prepare("SELECT id FROM catalog_platform").all() as Array<{ id: string }>).map((row) => row.id);
  const serviceId = serviceIdentifier(platform, id, platformIds);
  if (!isPlatformId(platform) || !serviceId || !isServiceId(serviceId) || serviceId.endsWith("_network")) {
    return { code: "bad_id", value: id.trim() };
  }
  if (!isLabel(name) || !isLabel(groupName) || (network !== "required" && network !== "optional")) {
    return { code: "bad_id", value: id.trim() };
  }
  if (!isConfig(config)) return { code: config.trim().length > 500 ? "config_too_long" : "config_required", value: serviceId };
  const platformRow = db.prepare("SELECT id FROM catalog_platform WHERE id = ?").get(platform);
  if (!platformRow) return { code: "platform_unknown", value: platform };
  const existing = db.prepare("SELECT id FROM catalog_service WHERE platform_id = ? AND id = ?").get(platform, serviceId) as
    | { id: string }
    | undefined;
  if (existing) return { code: "service_exists", value: serviceId };
  const sameLabel = db
    .prepare("SELECT id FROM catalog_service WHERE platform_id = ? AND lower(label) = lower(?)")
    .get(platform, name) as { id: string } | undefined;
  if (sameLabel) return { code: "service_label_exists", value: name };
  const summary = network === "required" ? "必须进入一套网络" : "可不进网络";
  db.prepare(
    `INSERT INTO catalog_service (platform_id, id, label, group_name, network, enabled, summary, config)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(platform, serviceId, name, groupName, network, summary, config.trim());
  return null;
}

export function saveServiceConfig(db: DatabaseSync, platformId: string, id: string, config: string): CatalogNotice | null {
  const platform = platformId.trim().toLowerCase();
  const serviceId = id.trim();
  const row = db.prepare("SELECT id FROM catalog_service WHERE platform_id = ? AND id = ?").get(platform, serviceId) as
    | { id: string }
    | undefined;
  if (!row) return { code: "service_unknown", value: serviceId };
  if (!isConfig(config)) return { code: config.trim().length > 500 ? "config_too_long" : "config_required", value: serviceId };
  db.prepare("UPDATE catalog_service SET config = ? WHERE platform_id = ? AND id = ?").run(config.trim(), platform, serviceId);
  return null;
}

export function addRegion(
  db: DatabaseSync,
  platformId: string,
  regionId: string,
  label: string,
  zones: Array<{ id: string; label: string }>,
): CatalogNotice | null {
  const platform = platformId.trim().toLowerCase();
  const region = regionId.trim().toLowerCase();
  const name = label.trim() || region;
  if (!isPlatformId(platform) || !isRegionId(region) || !isLabel(name)) return { code: "bad_id", value: regionId.trim() };
  if (zones.length > 8) return { code: "too_many_zones", value: String(zones.length) };
  const cleaned = zones.map((zone) => ({
    id: zone.id.trim().toLowerCase(),
    label: zone.label.trim() || zone.id.trim().toLowerCase(),
  }));
  if (cleaned.some((zone) => !isZoneId(zone.id) || !isLabel(zone.label))) return { code: "bad_id", value: region };
  const repeated = repeatedValues(cleaned.map((zone) => zone.id));
  if (repeated) return { code: "zone_duplicate", value: repeated };
  const repeatedLabel = repeatedValues(cleaned.map((zone) => zone.label.toLowerCase()));
  if (repeatedLabel) return { code: "zone_duplicate", value: repeatedLabel };
  const platformRow = db.prepare("SELECT id FROM catalog_platform WHERE id = ?").get(platform);
  if (!platformRow) return { code: "platform_unknown", value: platform };
  const regionRow = db.prepare("SELECT id FROM catalog_region WHERE platform_id = ? AND id = ?").get(platform, region) as
    | { id: string }
    | undefined;
  const sameLabel = db
    .prepare("SELECT id FROM catalog_region WHERE platform_id = ? AND id != ? AND lower(label) = lower(?)")
    .get(platform, region, name) as { id: string } | undefined;
  if (sameLabel) return { code: "region_label_exists", value: name };
  if (!regionRow && cleaned.length === 0) {
    db.prepare("INSERT INTO catalog_region (platform_id, id, label) VALUES (?, ?, ?)").run(platform, region, name);
    return null;
  }
  if (!regionRow) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("INSERT INTO catalog_region (platform_id, id, label) VALUES (?, ?, ?)").run(platform, region, name);
      const insertZone = db.prepare(
        "INSERT INTO catalog_zone (platform_id, region_id, id, label) VALUES (?, ?, ?, ?)",
      );
      for (const zone of cleaned) insertZone.run(platform, region, zone.id, zone.label);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return null;
  }
  if (cleaned.length === 0) return { code: "region_exists", value: region };
  const stored = db
    .prepare("SELECT id, label FROM catalog_zone WHERE platform_id = ? AND region_id = ?")
    .all(platform, region) as Array<{ id: string; label: string }>;
  const storedIds = new Set(stored.map((zone) => zone.id));
  const storedLabels = new Set(stored.map((zone) => zone.label.toLowerCase()));
  const existingIds = cleaned.filter((zone) => storedIds.has(zone.id)).map((zone) => zone.id);
  if (existingIds.length > 0) return { code: "zone_exists", value: existingIds.join("、") };
  const existingLabels = cleaned.filter((zone) => storedLabels.has(zone.label.toLowerCase())).map((zone) => zone.label);
  if (existingLabels.length > 0) return { code: "zone_label_exists", value: existingLabels.join("、") };
  const insertZone = db.prepare("INSERT INTO catalog_zone (platform_id, region_id, id, label) VALUES (?, ?, ?, ?)");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const zone of cleaned) insertZone.run(platform, region, zone.id, zone.label);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return null;
}

function repeatedValues(values: string[]): string {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].join("、");
}
