import assert from "node:assert/strict";
import test from "node:test";
import { admit, builtinSnapshot, SERVICES } from "../src/catalog.ts";

function sid(platform: string, id: string): string {
  return `${platform}_${id}`;
}

test("two resources can use different networks", () => {
  const result = admit({
    platform: "aws",
    region: "ap-east-1",
    services: [sid("aws", "compute_vm"), sid("aws", "object_storage")],
    networks: [
      { name: "app", cidr: "" },
      { name: "data", cidr: "10.13.0.0/16" },
    ],
    serviceNetwork: { [sid("aws", "compute_vm")]: "app", [sid("aws", "object_storage")]: "data" },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.selection.networks[0].cidr, "10.1.0.0/16");
  assert.equal(result.selection.parameters[sid("aws", "object_storage")].network, "data");
});

test("a resource can ask for more than one instance", () => {
  const id = sid("aws", "compute_vm");
  const input = {
    platform: "aws",
    region: "ap-east-1",
    services: [id],
    networks: [{ name: "app", cidr: "" }],
    serviceNetwork: { [id]: "app" },
    serviceConfig: { [id]: "规格 small" },
  };
  const several = admit({ ...input, serviceCount: { [id]: "3" } });
  assert.equal(several.ok, true);
  if (!several.ok) return;
  assert.equal(several.selection.parameters[id].count, 3);
  const omitted = admit(input);
  assert.equal(omitted.ok, true);
  if (!omitted.ok) return;
  assert.equal(omitted.selection.parameters[id].count, 1);
  for (const count of ["0", "11", "2.5", "-1", "01"]) {
    assert.deepEqual(admit({ ...input, serviceCount: { [id]: count } }), { ok: false, code: "count_invalid" });
  }
});

test("object storage may stay off the network", () => {
  const result = admit({
    platform: "aliyun",
    region: "cn-hongkong",
    services: [sid("aliyun", "object_storage")],
    networks: [],
    serviceNetwork: { [sid("aliyun", "object_storage")]: "" },
  });
  assert.equal(result.ok, true);
});

test("a vm requires a declared network and an unused network is rejected", () => {
  const missing = admit({
    platform: "azure",
    region: "eastasia",
    services: [sid("azure", "compute_vm")],
    networks: [{ name: "app", cidr: "" }],
    serviceNetwork: { [sid("azure", "compute_vm")]: "" },
  });
  assert.deepEqual(missing, { ok: false, code: "service_requires_network" });
  const unused = admit({
    platform: "azure",
    region: "eastasia",
    services: [sid("azure", "compute_vm")],
    networks: [
      { name: "app", cidr: "" },
      { name: "extra", cidr: "" },
    ],
    serviceNetwork: { [sid("azure", "compute_vm")]: "app" },
  });
  assert.deepEqual(unused, { ok: false, code: "network_unused" });
});

test("each enabled product follows its network rule", () => {
  for (const service of SERVICES) {
    if (!service.enabled) continue;
    const id = sid("aliyun", service.id);
    const placed = admit({
      platform: "aliyun",
      region: "cn-hongkong",
      services: [id],
      networks: [{ name: "app", cidr: "" }],
      serviceNetwork: { [id]: "app" },
    });
    assert.equal(placed.ok, true, id);
    const bare = admit({
      platform: "aliyun",
      region: "cn-hongkong",
      services: [id],
      networks: [],
      serviceNetwork: { [id]: "" },
    });
    assert.equal(bare.ok, service.network === "optional", id);
  }
});

test("a database requires a network and a queue may share it or stay off", () => {
  const missing = admit({
    platform: "aws",
    region: "ap-east-1",
    services: [sid("aws", "relational_database"), sid("aws", "message_queue")],
    networks: [{ name: "app", cidr: "" }],
    serviceNetwork: { [sid("aws", "relational_database")]: "", [sid("aws", "message_queue")]: "" },
  });
  assert.deepEqual(missing, { ok: false, code: "service_requires_network" });
  const shared = admit({
    platform: "aws",
    region: "ap-east-1",
    services: [
      sid("aws", "relational_database"),
      sid("aws", "cache"),
      sid("aws", "message_queue"),
      sid("aws", "key_management"),
    ],
    networks: [{ name: "app", cidr: "" }],
    serviceNetwork: {
      [sid("aws", "relational_database")]: "app",
      [sid("aws", "cache")]: "app",
      [sid("aws", "message_queue")]: "",
      [sid("aws", "key_management")]: "app",
    },
  });
  assert.equal(shared.ok, true);
  if (!shared.ok) return;
  assert.equal(shared.selection.parameters[sid("aws", "cache")].network, "app");
  assert.equal(shared.selection.parameters[sid("aws", "message_queue")].network, undefined);
  assert.equal(shared.selection.parameters[sid("aws", "message_queue")].config, "单实例");
});

test("a custom platform can use its own region, zone and network name", () => {
  const catalog = builtinSnapshot();
  catalog.platforms.push({ id: "gcp", label: "Google", enabled: true });
  catalog.services.push({
    platformId: "gcp",
    id: "gcp_compute_vm",
    label: "云主机",
    group: "计算",
    network: "required",
    enabled: true,
    summary: "必须进入一套网络",
    config: "规格 small",
  });
  catalog.regions.push({ platformId: "gcp", id: "asia-east1", label: "台湾" });
  catalog.zones.push({ platformId: "gcp", regionId: "asia-east1", id: "asia-east1-a", label: "可用区 A" });
  const ok = admit(
    {
      platform: "gcp",
      region: "asia-east1",
      services: ["gcp_compute_vm"],
      networks: [{ name: "app", cidr: "" }],
      serviceNetwork: { gcp_compute_vm: "app" },
      zones: ["asia-east1-a"],
    },
    false,
    catalog,
  );
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.equal(ok.selection.networks[0].cidr, "10.40.0.0/16");
  assert.deepEqual(ok.selection.zones, ["asia-east1-a"]);
  const wrongZone = admit(
    {
      platform: "gcp",
      region: "asia-east1",
      services: ["gcp_compute_vm"],
      networks: [{ name: "app", cidr: "" }],
      serviceNetwork: { gcp_compute_vm: "app" },
      zones: ["asia-east1-b"],
    },
    false,
    catalog,
  );
  assert.deepEqual(wrongZone, { ok: false, code: "zone_unknown" });
});

test("kubernetes stays disabled", () => {
  const result = admit({
    platform: "aws",
    region: "ap-east-1",
    services: [sid("aws", "managed_kubernetes")],
    networks: [{ name: "app", cidr: "" }],
    serviceNetwork: { [sid("aws", "managed_kubernetes")]: "app" },
  });
  assert.deepEqual(result, { ok: false, code: "platform_disabled" });
});
