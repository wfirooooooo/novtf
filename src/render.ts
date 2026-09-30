import { SERVICE_COUNT_MAX, storedServiceCount, type NormalizedSelection } from "./catalog.ts";

export interface RenderFile {
  name: string;
  body: string;
}

const PROVIDERS: Record<string, { key: string; source: string; version: string }> = {
  aws: { key: "aws", source: "hashicorp/aws", version: "= 6.66.0" },
  azure: { key: "azurerm", source: "hashicorp/azurerm", version: "= 5.7.0" },
  aliyun: { key: "alicloud", source: "aliyun/alicloud", version: "= 1.293.0" },
};

// 按职责拆分文件：backend.tf 固定版本与远程状态，providers.tf 配置云连接，
// main.tf 只组装模块传参（不放裸资源），variables.tf 声明入参并固化校验，
// terraform.tfvars 只放环境差异化取值。
export function renderTerraform(stackId: string, selection: NormalizedSelection): RenderFile[] {
  const pinned = PROVIDERS[selection.platform];
  const providerKey = pinned?.key ?? selection.platform;
  const state = stateAddress(stackId, selection.platform, selection.region);
  const backend = {
    terraform: {
      required_version: ">= 1.16.4, < 1.17.0",
      required_providers: {
        [providerKey]: pinned
          ? { source: pinned.source, version: pinned.version }
          : { source: "unreviewed", version: "unreviewed" },
      },
      backend: {
        http: {
          address: state,
          lock_address: `${state}/lock`,
          unlock_address: `${state}/unlock`,
          lock_method: "POST",
          unlock_method: "POST",
        },
      },
    },
  };
  const providers = {
    provider: {
      [providerKey]: providerKey === "azurerm" ? { features: {} } : { region: selection.region },
    },
  };
  // main 只做一件事：组装模块 + 传参，不放裸资源
  const modules: Record<string, Record<string, string>> = {};
  if (selection.platform === "azure" && selection.networks.length > 0) {
    modules.resource_group = {
      source: "./modules/azure/resource-group",
      name: `novtf${stackId.replace(/-/g, "").slice(0, 16)}`,
      location: "${var.region}",
    };
  }
  for (const network of selection.networks) {
    modules[`network_${network.name}`] = {
      source: `./modules/${selection.platform}/network`,
      cidr: `\${var.networks.${network.name}.cidr}`,
    };
  }
  for (const service of selection.services) {
    const parameter = selection.parameters[service] ?? { config: "", count: 1 };
    const block: Record<string, string> = {
      source: `./modules/${selection.platform}/${serviceBody(selection.platform, service)}`,
      count: `\${var.services.${service}.count}`,
      config: `\${var.services.${service}.config}`,
    };
    if (parameter.network) block.network = `\${var.services.${service}.network}`;
    modules[service] = block;
  }
  const main: Record<string, unknown> = { module: modules };
  // 通用声明与默认值放 variables，约定固化成 validation
  const variables = {
    variable: {
      region: {
        description: "云平台地域，由环境取值文件指定",
        type: "string",
        validation: {
          condition: "${length(var.region) > 0}",
          error_message: "region 不能为空。",
        },
      },
      zones: {
        description: "可用区列表，无多可用区需求时留空",
        type: "list(string)",
        default: [] as string[],
      },
      networks: {
        description: "网络规划：键为网络名，值为网段",
        type: "map(object({ cidr = string }))",
        validation: {
          condition: "${alltrue([for network in values(var.networks) : can(cidrhost(network.cidr, 0))])}",
          error_message: "每个网络的 cidr 必须是合法网段。",
        },
      },
      services: {
        description: "服务清单：数量、规格说明与所在网络",
        type: "map(object({ count = number, config = string, network = optional(string) }))",
        validation: {
          condition: `\${alltrue([for service in values(var.services) : service.count >= 1 && service.count <= ${SERVICE_COUNT_MAX}])}`,
          error_message: `每个服务的 count 必须在 1 到 ${SERVICE_COUNT_MAX} 之间。`,
        },
      },
    },
  };
  const networks = Object.fromEntries(selection.networks.map((network) => [network.name, { cidr: network.cidr }]));
  const services = Object.fromEntries(
    selection.services.map((service) => {
      const parameter = selection.parameters[service] ?? { config: "", count: 1 };
      const value: { count: number; config: string; network?: string } = {
        count: storedServiceCount(parameter.count),
        config: parameter.config,
      };
      if (parameter.network) value.network = parameter.network;
      return [service, value];
    }),
  );
  // 环境差异只体现在 tfvars
  const tfvars = {
    region: selection.region,
    zones: selection.zones,
    networks,
    services,
  };
  return [
    { name: "backend.tf.json", body: json(backend) },
    { name: "providers.tf.json", body: json(providers) },
    { name: "main.tf.json", body: json(main) },
    { name: "variables.tf.json", body: json(variables) },
    { name: "terraform.tfvars.json", body: json(tfvars) },
  ];
}

function serviceBody(platform: string, service: string): string {
  const prefix = `${platform}_`;
  return service.startsWith(prefix) ? service.slice(prefix.length) : service;
}

function stateAddress(stackId: string, platform: string, region: string): string {
  return `http://state:8081/v1/${encodeURIComponent(stackId)}/${encodeURIComponent(platform)}/${encodeURIComponent(region)}`;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
