import assert from "node:assert/strict";
import test from "node:test";
import type { NormalizedSelection } from "../src/catalog.ts";
import { highlightJson } from "../src/highlight.ts";
import { renderTerraform } from "../src/render.ts";

function visible(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

test("json highlighting keeps the text and separates keys, values, and structure", () => {
  const source = [
    "{",
    '  "name": "hk <app> & co",',
    '  "count": 2,',
    '  "on": true,',
    '  "note": null,',
    '  "msg": "say \\"hi\\"",',
    '  "ref": "${var.region}",',
    '  "plain": "\\\\${not.a.ref}"',
    "}",
    "",
  ].join("\n");
  const html = highlightJson(source);
  assert.equal(visible(html), source);
  assert.match(html, /class="tok-key">&quot;name&quot;</);
  assert.match(html, /class="tok-str">&quot;hk &lt;app&gt; &amp; co&quot;</);
  assert.match(html, /class="tok-num">2</);
  assert.match(html, /class="tok-lit">true</);
  assert.match(html, /class="tok-lit">null</);
  assert.match(html, /class="tok-pun">\{</);
  assert.match(html, /class="tok-ref">\$\{var\.region\}</);
  assert.equal(html.includes("<app>"), false);
  assert.equal(html.includes("<script"), false);
  assert.equal(html.includes('class="tok-ref">${not'), false);
});

test("colored terraform files keep the generated text", () => {
  const selection: NormalizedSelection = {
    platform: "aws",
    region: "ap-east-1",
    services: ["aws_compute_vm"],
    networks: [{ name: "app", cidr: "10.1.0.0/16" }],
    zones: ["ap-east-1a"],
    parameters: { aws_compute_vm: { network: "app", config: "规格 small（t3.micro）" } },
  };
  const files = renderTerraform("11111111-1111-1111-1111-111111111111", selection);
  for (const file of files) {
    const html = highlightJson(file.body);
    assert.equal(visible(html), file.body);
    assert.match(html, /class="tok-key"/);
    assert.match(html, /class="tok-str"/);
    assert.equal(file.body.includes("password"), false);
  }
  assert.match(highlightJson(files[2]?.body ?? ""), /class="tok-ref">\$\{var\.networks\.app\.cidr\}</);
});
