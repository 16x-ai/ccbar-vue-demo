import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse, compileScript, compileTemplate } from "@vue/compiler-sfc";

for (const filename of ["src/App.vue"]) {
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
