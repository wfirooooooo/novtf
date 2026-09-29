import { storedServiceCount, type NormalizedSelection } from "./catalog.ts";

export interface RenderFile {
  name: string;
  body: string;
}

const PROVIDERS: Record<string, { key: string; source: string; version: string }> = {
  aws: { key: "aws", source: "hashicorp/aws", version: "= 6.66.0" },
  azure: { key: "azurerm", source: "hashicorp/azurerm", version: "= 5.7.0" },
  aliyun: { key: "alicloud", source: "aliyun/alicloud", version: "= 1.293.0" },
};

export function renderTerraform(stackId: string, selection: NormalizedSelection): RenderFile[] {
  const pinned = PROVIDERS[selection.platform];
  const providerKey = pinned?.key ?? selection.platform;
  const state = stateAddress(stackId, selection.platform, selection.region);
  const root = {
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
    provider: {
      [providerKey]: providerKey === "azurerm" ? { features: {} } : { region: selection.region },
    },
  };
  const modules: Record<string, Record<string, string>> = {};
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
  const main: Record<string, unknown> = {};
  if (selection.platform === "azure" && selection.networks.length > 0) {
    main.resource = {
      azurerm_resource_group: {
        this: {
          name: `novtf${stackId.replace(/-/g, "").slice(0, 16)}`,
          location: "${var.region}",
        },
      },
    };
  }
  main.module = modules;
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
  const tfvars = {
    region: selection.region,
    zones: selection.zones,
    networks,
    services,
  };
  return [
    { name: "terraform.tf.json", body: json(root) },
    { name: "main.tf.json", body: json(main) },
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
