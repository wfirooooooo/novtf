import assert from "node:assert/strict";
import test from "node:test";
import type { NormalizedSelection } from "../src/catalog.ts";
import { renderTerraform } from "../src/render.ts";

function selection(overrides: Partial<NormalizedSelection> = {}): NormalizedSelection {
  return {
    platform: "aws",
    region: "ap-east-1",
    services: ["aws_compute_vm", "aws_object_storage"],
    networks: [{ name: "app", cidr: "10.1.0.0/16" }],
    zones: ["ap-east-1a"],
    parameters: {
      aws_compute_vm: { network: "app", config: '规格 small（t3.micro）\n磁盘 "20 GB"' },
      aws_object_storage: { config: "私有存储" },
    },
    ...overrides,
  };
}

test("rendered files are auditable terraform json and contain no credentials", () => {
  const files = renderTerraform("11111111-1111-1111-1111-111111111111", selection());
  assert.deepEqual(
    files.map((file) => file.name),
    ["terraform.tf.json", "main.tf.json", "terraform.tfvars.json"],
  );
  const combined = files.map((file) => file.body).join("\n");
  assert.equal(combined.includes("password"), false);
  assert.equal(combined.includes("secret"), false);
  assert.equal(combined.includes("token"), false);
  const root = JSON.parse(files[0].body) as {
    terraform: { backend: { http: { address: string } }; required_providers: { aws: { source: string } } };
    provider: { aws: { region: string } };
  };
  assert.equal(root.terraform.required_providers.aws.source, "hashicorp/aws");
  assert.equal(root.provider.aws.region, "ap-east-1");
  assert.match(root.terraform.backend.http.address, /\/v1\/11111111-1111-1111-1111-111111111111\/aws\/ap-east-1$/);
  const main = JSON.parse(files[1].body) as { module: Record<string, { source: string; count?: string }> };
  assert.equal(main.module.network_app.source, "./modules/aws/network");
  assert.equal(main.module.aws_compute_vm.source, "./modules/aws/compute_vm");
  assert.equal(main.module.aws_object_storage.source, "./modules/aws/object_storage");
  assert.equal("network" in main.module.aws_object_storage, false);
  assert.equal(main.module.aws_compute_vm.count, "${var.services.aws_compute_vm.count}");
  const tfvars = JSON.parse(files[2].body) as { services: { aws_compute_vm: { config: string; network: string; count: number } } };
  assert.equal(tfvars.services.aws_compute_vm.count, 1);
  assert.equal(tfvars.services.aws_compute_vm.network, "app");
  assert.match(tfvars.services.aws_compute_vm.config, /20 GB/);
});

test("azure root contains one resource group when a network is declared", () => {
  const files = renderTerraform("22222222-2222-2222-2222-222222222222", selection({
    platform: "azure",
    region: "eastasia",
    services: ["azure_compute_vm"],
    networks: [{ name: "app", cidr: "10.2.0.0/16" }],
    zones: [],
    parameters: { azure_compute_vm: { network: "app", config: "规格 small" } },
  }));
  const root = JSON.parse(files[0].body) as { provider: { azurerm: { features: object } } };
  assert.deepEqual(root.provider.azurerm.features, {});
  const main = JSON.parse(files[1].body) as { resource: { azurerm_resource_group: { this: { name: string } } } };
  assert.equal(main.resource.azurerm_resource_group.this.name, "novtf2222222222222222");
});

test("an unreviewed platform is marked instead of inventing a provider", () => {
  const files = renderTerraform("33333333-3333-3333-3333-333333333333", selection({
    platform: "gcp",
    region: "asia-east1",
    services: ["gcp_cloud_disk"],
    networks: [],
    zones: [],
    parameters: { gcp_cloud_disk: { config: "容量 100 GB" } },
  }));
  const root = JSON.parse(files[0].body) as { terraform: { required_providers: { gcp: { source: string } } } };
  assert.equal(root.terraform.required_providers.gcp.source, "unreviewed");
  const main = JSON.parse(files[1].body) as { resource?: unknown; module: { gcp_cloud_disk: { source: string } } };
  assert.equal(main.resource, undefined);
  assert.equal(main.module.gcp_cloud_disk.source, "./modules/gcp/cloud_disk");
});

test("requested quantity is copied into the module count", () => {
  const files = renderTerraform(
    "44444444-4444-4444-4444-444444444444",
    selection({
      parameters: {
        aws_compute_vm: { network: "app", config: "规格 small", count: 3 },
        aws_object_storage: { config: "私有存储", count: 1 },
      },
    }),
  );
  const main = JSON.parse(files[1].body) as { module: { aws_compute_vm: { count: string } } };
  const tfvars = JSON.parse(files[2].body) as { services: { aws_compute_vm: { count: number } } };
  assert.equal(main.module.aws_compute_vm.count, "${var.services.aws_compute_vm.count}");
  assert.equal(tfvars.services.aws_compute_vm.count, 3);
});
