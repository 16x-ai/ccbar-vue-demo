import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse, compileScript, compileTemplate } from "@vue/compiler-sfc";

const components = [
  "src/App.vue",
  "src/components/SettingsDialog.vue",
  "src/components/LogPanel.vue",
  "src/components/IncomingCallModal.vue",
  "src/components/LoadingOverlay.vue",
];

for (const filename of components) {
  test(`${filename} 的 Vue 脚本与模板可编译`, () => {
    const source = readFileSync(
      new URL(`../${filename}`, import.meta.url),
      "utf8",
    );
    const { descriptor, errors } = parse(source, { filename });
    assert.deepEqual(errors, []);
    const script = compileScript(descriptor, { id: filename });
    const template = compileTemplate({
      id: filename,
      filename,
      source: descriptor.template!.content,
      compilerOptions: {
        bindingMetadata: script.bindings,
        isCustomElement: (tag) => tag === "xcall-ccbar",
      },
    });
    assert.deepEqual(template.errors, []);
  });
}

test("签入按钮接上了（App.vue）", () => {
  const source = readFileSync(new URL("../src/App.vue", import.meta.url), "utf8");
  assert.match(source, /id="____ccbar_signin____"/);
  assert.match(source, /phone\.run\('签入', phone\.signIn\)/);
  // 页面上只有一条会话来源：没有「签入2」按钮
  assert.doesNotMatch(source, /signin2|signIn2|signInServer/);
});
