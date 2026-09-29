export const PLATFORMS = ["aws", "azure", "aliyun"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const PLATFORM_LABEL: Record<Platform, string> = {
  aws: "AWS",
  azure: "Azure",
  aliyun: "阿里云",
};

export interface ServiceSpec {
  id: string;
  label: string;
  group: string;
  network: "required" | "optional";
  enabled: boolean;
  summary: string;
  config: string;
}

export interface CatalogService extends ServiceSpec {
  platformId: string;
}

export interface CatalogSnapshot {
  platforms: Array<{ id: string; label: string; enabled: boolean }>;
  services: CatalogService[];
  regions: Array<{ platformId: string; id: string; label: string }>;
  zones: Array<{ platformId: string; regionId: string; id: string; label: string }>;
}

export const SERVICES: readonly ServiceSpec[] = [
  { id: "compute_vm", label: "云主机", group: "计算", network: "required", enabled: true, summary: "必须进入一套网络", config: "规格 small\n不分配公网 IP" },
  { id: "serverless_function", label: "函数", group: "计算", network: "optional", enabled: true, summary: "可不进网络；指定后只从该网络进入", config: "内存 128 MB\n超时 30 秒" },
  { id: "managed_kubernetes", label: "托管 Kubernetes", group: "计算", network: "required", enabled: false, summary: "默认关闭", config: "默认关闭\n节点数 1\n需要管理网段" },
  { id: "relational_database", label: "关系型数据库", group: "数据", network: "required", enabled: true, summary: "必须进入一套网络", config: "规格 small\n单节点\n存储 20 GB" },
  { id: "cache", label: "缓存", group: "数据", network: "required", enabled: true, summary: "必须进入一套网络", config: "规格 small" },
  { id: "object_storage", label: "对象存储", group: "数据", network: "optional", enabled: true, summary: "可不进网络；指定后关闭公网", config: "私有存储\n名称由系统生成\n不开放公网访问" },
  { id: "file_storage", label: "文件存储", group: "数据", network: "required", enabled: true, summary: "必须进入一套网络", config: "规格 small\n容量 100 GB" },
  { id: "load_balancer", label: "负载均衡", group: "应用", network: "required", enabled: true, summary: "必须进入一套网络", config: "内网负载均衡" },
  { id: "message_queue", label: "消息队列", group: "应用", network: "optional", enabled: true, summary: "可不进网络；指定后走私有入口", config: "单实例" },
  { id: "container_registry", label: "容器镜像", group: "应用", network: "optional", enabled: true, summary: "可不进网络；指定后走私有入口", config: "私有镜像仓库" },
  { id: "key_management", label: "密钥管理", group: "安全", network: "optional", enabled: true, summary: "可不进网络；指定后走私有入口", config: "平台托管密钥" },
];

export function builtinConfig(platformId: string, serviceId: string, fallback: string): string {
  if (serviceId === "compute_vm" && platformId === "aws") return "规格 small（t3.micro）\n不分配公网 IP\n系统镜像 Amazon Linux 2023";
  if (serviceId === "compute_vm" && platformId === "azure") return "规格 small（Standard_B1s）\n不分配公网 IP\n镜像 Ubuntu 22.04\n需要一行 SSH 公钥";
  if (serviceId === "compute_vm" && platformId === "aliyun") return "规格 small（1 vCPU、2 GiB）\n不分配公网 IP\n镜像 Ubuntu 22.04\n需要一行 SSH 公钥";
  if (serviceId === "managed_kubernetes" && platformId === "azure") return "默认关闭\n节点数 1，规格 Standard_D2s_v3\n需要管理网段";
  return fallback;
}

export function serviceSpec(id: string): ServiceSpec | undefined {
  return SERVICES.find((service) => service.id === id);
}

const REGION_LABEL: Record<string, string> = {
  "ap-east-1": "香港",
  "ap-southeast-1": "新加坡",
  "us-east-1": "弗吉尼亚",
  eastasia: "香港",
  southeastasia: "新加坡",
  westeurope: "荷兰",
  "cn-hongkong": "香港",
  "cn-hangzhou": "杭州",
};

export function regionText(region: string): string {
  const label = REGION_LABEL[region];
  return label ? `${label} · ${region}` : region;
}

export function placeText(label: string, id: string): string {
  const text = label.trim();
  return text && text !== id ? `${text} · ${id}` : id;
}

export function builtinSnapshot(): CatalogSnapshot {
  return {
    platforms: PLATFORMS.map((id) => ({ id, label: PLATFORM_LABEL[id], enabled: true })),
    services: PLATFORMS.flatMap((platformId) =>
      SERVICES.map((service) => ({
        ...service,
        id: `${platformId}_${service.id}`,
        platformId,
        config: builtinConfig(platformId, service.id, service.config),
      })),
    ),
    regions: PLATFORMS.flatMap((platformId) =>
      REGIONS[platformId].map((id) => ({ platformId, id, label: REGION_LABEL[id] ?? id })),
    ),
    zones: [],
  };
}

export function isPlatformId(value: string): boolean {
  return /^[a-z][a-z0-9-]{0,20}$/.test(value);
}

export function isServiceId(value: string): boolean {
  return value !== "network" && /^[a-z][a-z0-9_]{0,63}$/.test(value);
}

export function isRegionId(value: string): boolean {
  return /^[a-z][a-z0-9-]{0,32}$/.test(value);
}

export function isZoneId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,32}$/.test(value);
}

export function isLabel(value: string): boolean {
  const text = value.trim();
  return text.length > 0 && text.length <= 40 && !/[\u0000-\u001f]/.test(text);
}

export function isConfig(value: string): boolean {
  const text = value.trim();
  return text.length > 0 && text.length <= 500 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text);
}

export const SERVICE_COUNT_MAX = 10;

export function parseServiceCount(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return 1;
  if (!/^[1-9][0-9]*$/.test(raw.trim())) return null;
  const value = Number(raw);
  return value <= SERVICE_COUNT_MAX ? value : null;
}

export function storedServiceCount(value: unknown): number {
  const number = typeof value === "number" ? value : Number.NaN;
  return Number.isInteger(number) && number >= 1 && number <= SERVICE_COUNT_MAX ? number : 1;
}

export const REGIONS: Record<Platform, string[]> = {
  aws: ["ap-east-1", "ap-southeast-1", "us-east-1"],
  azure: ["eastasia", "southeastasia", "westeurope"],
  aliyun: ["cn-hongkong", "cn-hangzhou", "ap-southeast-1"],
};

const DEFAULT_CIDR: Record<Platform, string[]> = {
  aws: ["10.1.0.0/16", "10.11.0.0/16", "10.12.0.0/16"],
  azure: ["10.2.0.0/16", "10.21.0.0/16", "10.22.0.0/16"],
  aliyun: ["10.3.0.0/16", "10.31.0.0/16", "10.32.0.0/16"],
};

const NAME = /^[a-z][a-z0-9]{0,15}$/;

export interface NetworkChoice {
  name: string;
  cidr: string;
}

export interface SelectionInput {
  platform: string;
  region: string;
  services: string[];
  networks: Array<{ name: string; cidr: string }>;
  serviceNetwork: Record<string, string>;
  serviceConfig?: Record<string, string>;
  serviceCount?: Record<string, string>;
  zones?: string[];
}

export interface ServiceParameters {
  network?: string;
  config: string;
  count: number;
}

export interface NormalizedSelection {
  platform: string;
  region: string;
  services: string[];
  networks: NetworkChoice[];
  zones: string[];
  parameters: Record<string, ServiceParameters>;
}

export function isPlatform(value: string): value is Platform {
  return (PLATFORMS as readonly string[]).includes(value);
}

export function admit(
  input: SelectionInput,
  kubernetesEnabled = false,
  catalog: CatalogSnapshot = builtinSnapshot(),
): { ok: true; selection: NormalizedSelection } | { ok: false; code: string } {
  const platform = input.platform;
  const platformSpec = catalog.platforms.find((item) => item.id === platform);
  if (!platformSpec?.enabled) return { ok: false, code: "platform_disabled" };
  if (!catalog.regions.some((region) => region.platformId === platform && region.id === input.region)) {
    return { ok: false, code: "region_unknown" };
  }
  if (input.services.includes("network")) return { ok: false, code: "network_not_a_service" };
  const specs = catalog.services.filter((service) => service.platformId === platform);
  const byId = new Map(specs.map((service) => [service.id, service]));
  if (
    input.services.some((service) => {
      const spec = byId.get(service);
      return spec !== undefined && !spec.enabled && !(isManagedKubernetes(service) && kubernetesEnabled);
    })
  ) {
    return { ok: false, code: "platform_disabled" };
  }
  if (input.services.length === 0 || input.services.some((service) => !byId.has(service))) {
    return { ok: false, code: "service_unknown" };
  }
  const zones = [...new Set((input.zones ?? []).map((zone) => zone.trim()).filter((zone) => zone.length > 0))];
  const knownZones = new Set(
    catalog.zones.filter((zone) => zone.platformId === platform && zone.regionId === input.region).map((zone) => zone.id),
  );
  if (zones.some((zone) => !knownZones.has(zone))) return { ok: false, code: "zone_unknown" };
  const networks = input.networks
    .map((network) => ({ name: network.name.trim(), cidr: network.cidr.trim() }))
    .filter((network) => network.name.length > 0);
  if (networks.length > 3) return { ok: false, code: "too_many_networks" };
  if (networks.some((network) => !NAME.test(network.name))) return { ok: false, code: "duplicate_network_name" };
  if (new Set(networks.map((network) => network.name)).size !== networks.length) {
    return { ok: false, code: "duplicate_network_name" };
  }
  const defaults = DEFAULT_CIDR[platform as Platform];
  const withCidr = networks.map((network, index) => ({
    name: network.name,
    cidr: network.cidr || defaults?.[index] || `10.${40 + index}.0.0/16`,
  }));
  if (withCidr.some((network) => !isRfc1918Slash16(network.cidr))) return { ok: false, code: "cidr_not_slash16" };
  if (new Set(withCidr.map((network) => networkAddress(network.cidr))).size !== withCidr.length) {
    return { ok: false, code: "cidr_overlap" };
  }
  const names = new Set(withCidr.map((network) => network.name));
  const parameters: Record<string, ServiceParameters> = {};
  const services = specs.map((service) => service.id).filter((id) => input.services.includes(id));
  for (const service of services) {
    const spec = byId.get(service);
    const supplied = input.serviceConfig?.[service];
    const config = (supplied !== undefined ? supplied : (spec?.config ?? "")).trim();
    if (!isConfig(config)) return { ok: false, code: config.length > 500 ? "config_too_long" : "config_required" };
    const count = parseServiceCount(input.serviceCount?.[service]);
    if (count === null) return { ok: false, code: "count_invalid" };
    const chosen = (input.serviceNetwork[service] ?? "").trim();
    if (!chosen) {
      if (spec?.network === "optional") {
        parameters[service] = { config, count };
        continue;
      }
      return { ok: false, code: "service_requires_network" };
    }
    if (!names.has(chosen)) return { ok: false, code: "network_unknown" };
    parameters[service] = { network: chosen, config, count };
  }
  const used = new Set(
    Object.values(parameters)
      .map((item) => item.network)
      .filter((name): name is string => Boolean(name)),
  );
  if (withCidr.some((network) => !used.has(network.name))) return { ok: false, code: "network_unused" };
  return {
    ok: true,
    selection: {
      platform,
      region: input.region,
      services,
      networks: withCidr,
      zones,
      parameters,
    },
  };
}

function isManagedKubernetes(id: string): boolean {
  return id === "managed_kubernetes" || id.endsWith("_managed_kubernetes");
}

function isRfc1918Slash16(cidr: string): boolean {
  const match = cidr.match(/^(\d{1,3})\.(\d{1,3})\.0\.0\/16$/);
  if (!match) return false;
  const first = Number(match[1]);
  const second = Number(match[2]);
  if (first === 10 && second <= 255) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  return first === 192 && second === 168;
}

function networkAddress(cidr: string): number {
  const [first, second] = cidr.split(".").map(Number);
  return first * 256 + second;
}
