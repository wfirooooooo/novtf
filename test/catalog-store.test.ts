import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startApi } from "../src/api.ts";
import { admit } from "../src/catalog.ts";
import { addPlatform, addRegion, addService, loadCatalog, prefixStoredServiceIds, saveServiceConfig } from "../src/catalog-store.ts";
import { openDatabase } from "../src/db.ts";

test("existing service ids are stored with the platform prefix", () => {
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), "novtf-prefix-")), "novtf.sqlite"));
  const catalog = loadCatalog(db);
  assert.equal(catalog.services.find((service) => service.platformId === "aws" && service.label === "云主机")?.id, "aws_compute_vm");
  assert.ok(catalog.services.every((service) => service.id.startsWith(`${service.platformId}_`)));
  db.prepare(
    `INSERT INTO catalog_service (platform_id, id, label, group_name, network, enabled, summary)
     VALUES ('aws', 'legacy_disk', '旧盘', '数据', 'optional', 1, '可不进网络')`,
  ).run();
  db.prepare("INSERT INTO stack (id, name, created_at) VALUES ('s1', 'old', ?)").run(new Date().toISOString());
  db.prepare(
    `INSERT INTO stack_selection (stack_id, platform, region, services, networks, parameters, zones)
     VALUES ('s1', 'aws', 'ap-east-1', ?, '[]', ?, '[]')`,
  ).run(JSON.stringify(["compute_vm", "legacy_disk"]), JSON.stringify({ compute_vm: { network: "app" }, legacy_disk: {} }));
  prefixStoredServiceIds(db);
  const again = loadCatalog(db);
  assert.equal(again.services.find((service) => service.label === "旧盘")?.id, "aws_legacy_disk");
  assert.equal(again.services.filter((service) => service.platformId === "aws" && service.id === "aws_compute_vm").length, 1);
  const selection = db.prepare("SELECT services, parameters FROM stack_selection WHERE stack_id = 's1'").get() as {
    services: string;
    parameters: string;
  };
  assert.deepEqual(JSON.parse(selection.services), ["aws_compute_vm", "aws_legacy_disk"]);
  assert.equal(JSON.parse(selection.parameters).aws_compute_vm.network, "app");
  prefixStoredServiceIds(db);
  assert.equal(loadCatalog(db).services.find((service) => service.label === "旧盘")?.id, "aws_legacy_disk");
});

test("admin can add a platform, its service, a region and zones", async () => {
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), "novtf-catalog-")), "novtf.sqlite"));
  assert.equal(addPlatform(db, "GCP", "Google Cloud"), null);
  assert.deepEqual(addPlatform(db, "gcp", "Again"), { code: "platform_exists", value: "gcp" });
  assert.deepEqual(addPlatform(db, "google", "Google Cloud"), { code: "platform_label_exists", value: "Google Cloud" });
  assert.deepEqual(addService(db, "gcp", "cloud_disk", "云盘", "数据", "required", ""), {
    code: "config_required",
    value: "gcp_cloud_disk",
  });
  assert.equal(addService(db, "gcp", "cloud_disk", "云盘", "数据", "required", "容量 100 GB"), null);
  assert.deepEqual(addService(db, "gcp", "aws_disk", "磁盘", "数据", "optional", "容量 50 GB"), null);
  assert.deepEqual(addService(db, "gcp", "cloud_disk", "另一块盘", "数据", "required", "容量 100 GB"), {
    code: "service_exists",
    value: "gcp_cloud_disk",
  });
  assert.deepEqual(addService(db, "gcp", "other_disk", "云盘", "数据", "required", "容量 20 GB"), {
    code: "service_label_exists",
    value: "云盘",
  });
  assert.equal(saveServiceConfig(db, "gcp", "gcp_cloud_disk", "容量 200 GB"), null);
  assert.equal(loadCatalog(db).services.find((service) => service.id === "gcp_cloud_disk")?.config, "容量 200 GB");
  assert.equal(addRegion(db, "gcp", "asia-east1", "台湾", [{ id: "asia-east1-a", label: "可用区 A" }]), null);
  assert.equal(addRegion(db, "gcp", "asia-east1", "台湾", [{ id: "asia-east1-b", label: "" }]), null);
  assert.deepEqual(addRegion(db, "gcp", "asia-east1", "台湾", [{ id: "asia-east1-a", label: "可用区 A" }]), {
    code: "zone_exists",
    value: "asia-east1-a",
  });
  assert.deepEqual(addRegion(db, "gcp", "asia-east2", "台湾", []), { code: "region_label_exists", value: "台湾" });
  const catalog = loadCatalog(db);
  const gcp = catalog.platforms.find((platform) => platform.id === "gcp");
  assert.equal(gcp?.label, "Google Cloud");
  assert.equal(catalog.services.find((service) => service.platformId === "gcp" && service.label === "云盘")?.id, "gcp_cloud_disk");
  assert.equal(catalog.services.find((service) => service.label === "磁盘")?.id, "gcp_disk");
  assert.equal(catalog.zones.filter((zone) => zone.platformId === "gcp").length, 2);
  const admitted = admit(
    {
      platform: "gcp",
      region: "asia-east1",
      services: ["gcp_cloud_disk"],
      networks: [{ name: "data", cidr: "" }],
      serviceNetwork: { gcp_cloud_disk: "data" },
      zones: ["asia-east1-b"],
    },
    false,
    catalog,
  );
  assert.equal(admitted.ok, true);

  process.env.NOVTF_OPERATOR_PASSWORD = "bootstrap-secret";
  const server = await startApi(db, "127.0.0.1", 0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const base = `http://127.0.0.1:${address.port}`;
  try {
  const loggedIn = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "username=admin&password=bootstrap-secret",
    redirect: "manual",
  });
  const cookie = String(loggedIn.headers.get("set-cookie")).split(";")[0];
  const home = await fetch(`${base}/`, { headers: { cookie } });
  const html = await home.text();
  assert.match(html, /云平台/);
  assert.match(html, /自定义名称，例如 app/);
  assert.match(html, /Google Cloud/);
  const platforms = await fetch(`${base}/platforms`, { headers: { cookie } });
  const platformsHtml = await platforms.text();
  assert.match(platformsHtml, /新增云平台/);
  const csrf = platformsHtml.match(/name="csrf" value="([^"]+)"/)?.[1];
  assert.ok(csrf);
  const duplicate = await fetch(`${base}/platforms`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: `csrf=${encodeURIComponent(csrf)}&id=gcp&label=Again`,
    redirect: "manual",
  });
  assert.equal(duplicate.status, 302);
  const location = duplicate.headers.get("location") ?? "";
  assert.match(location, /error=platform_exists/);
  assert.match(location, /value=gcp/);
  const again = await fetch(new URL(location, base), { headers: { cookie } });
  assert.match(await again.text(), /云平台标识「gcp」已经存在/);
  const services = await fetch(`${base}/services`, { headers: { cookie } });
  const servicesHtml = await services.text();
  assert.match(servicesHtml, /class="id-prefix"/);
  assert.match(servicesHtml, /aws_cloud_disk/);
  assert.match(servicesHtml, /gcp_cloud_disk/);
  assert.match(servicesHtml, /资源配置/);
  assert.match(servicesHtml, /t3\.micro/);
  const stacksBefore = db.prepare("SELECT COUNT(*) AS n FROM stack").get() as { n: number };
  const failedBody = new URLSearchParams();
  failedBody.append("csrf", csrf);
  failedBody.append("stack_name", "keep-me");
  failedBody.append("platform", "aws");
  failedBody.append("aws_region", "us-east-1");
  failedBody.append("aws_service", "aws_compute_vm");
  failedBody.append("aws_service", "aws_object_storage");
  failedBody.append("aws_net_name", "app");
  failedBody.append("aws_net_name", "side");
  failedBody.append("aws_net_cidr", "10.9.9.0/24");
  failedBody.append("aws_aws_compute_vm_network", "2");
  failedBody.append("aws_aws_compute_vm_config", "保留这段配置");
  failedBody.append("aws_aws_compute_vm_count", "4");
  failedBody.append("aws_aws_object_storage_config", "私有桶保留");
  failedBody.append("aws_aws_object_storage_count", "2");
  failedBody.append("azure_net_name", "blue");
  const failed = await fetch(`${base}/stacks`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: failedBody,
    redirect: "manual",
  });
  assert.equal(failed.status, 302);
  const failedLocation = failed.headers.get("location") ?? "";
  assert.match(failedLocation, /error=cidr_not_slash16/);
  const stacksAfter = db.prepare("SELECT COUNT(*) AS n FROM stack").get() as { n: number };
  assert.equal(stacksAfter.n, stacksBefore.n);
  const failedPage = await fetch(new URL(failedLocation, base), { headers: { cookie } });
  const failedHtml = await failedPage.text();
  assert.match(failedHtml, /没有保存：CIDR 必须是 RFC1918 里的 IPv4 \/16/);
  assert.match(failedHtml, /value="keep-me"/);
  assert.match(failedHtml, /name="platform" value="aws" checked/);
  assert.match(failedHtml, /name="platform" value="azure">/);
  assert.match(failedHtml, /value="us-east-1" selected/);
  assert.match(failedHtml, /name="aws_service" value="aws_compute_vm" checked/);
  assert.match(failedHtml, /name="aws_service" value="aws_object_storage" checked/);
  assert.match(failedHtml, /value="app"/);
  assert.match(failedHtml, /value="side"/);
  assert.match(failedHtml, /value="10\.9\.9\.0\/24"/);
  assert.match(failedHtml, /value="blue"/);
  assert.match(failedHtml, /name="aws_aws_compute_vm_network"[\s\S]*?<option value="2" selected>/);
  assert.match(failedHtml, /保留这段配置/);
  assert.match(failedHtml, /私有桶保留/);
  assert.match(failedHtml, /name="aws_aws_compute_vm_count"[^>]*value="4"/);
  assert.match(failedHtml, /name="aws_aws_object_storage_count"[^>]*value="2"/);
  const stillThere = await fetch(`${base}/`, { headers: { cookie } });
  assert.match(await stillThere.text(), /value="keep-me"/);
  const before = db.prepare("SELECT COUNT(*) AS n FROM provider_run").get() as { n: number };
  const posted = await fetch(`${base}/stacks`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      csrf,
      stack_name: "audit-check",
      platform: "aws",
      aws_region: "ap-east-1",
      aws_service: "aws_compute_vm",
      aws_net_name: "app",
      aws_aws_compute_vm_network: "1",
      aws_aws_compute_vm_config: "规格 small（t3.micro）",
      aws_aws_compute_vm_count: "2",
    }),
    redirect: "manual",
  });
  assert.equal(posted.status, 302);
  const auditLocation = posted.headers.get("location") ?? "";
  assert.match(auditLocation, /\?audit=/);
  const after = db.prepare("SELECT COUNT(*) AS n FROM provider_run").get() as { n: number };
  assert.equal(after.n, before.n);
  const audit = await fetch(new URL(auditLocation, base), { headers: { cookie } });
  const auditHtml = await audit.text();
  assert.match(auditHtml, /backend\.tf\.json/);
  assert.match(auditHtml, /variables\.tf\.json/);
  assert.match(auditHtml, /hashicorp\/aws/);
  assert.match(auditHtml, /没有执行 terraform/);
  assert.match(auditHtml, /\$\{var\.services\.aws_compute_vm\.count\}/);
  assert.match(auditHtml, /云主机 × 2/);
  const stored = db.prepare("SELECT parameters FROM stack_selection WHERE stack_id = ?").get(auditLocation.split("audit=")[1]) as {
    parameters: string;
  };
  assert.equal(JSON.parse(stored.parameters).aws_compute_vm.count, 2);
  assert.equal(auditHtml.includes("password"), false);
  assert.equal(auditHtml.includes('value="keep-me"'), false);
  } finally {
    server.close();
  }
});
