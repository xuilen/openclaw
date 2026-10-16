import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { requestRaw, resolveConfigMutation } from "./model-providers.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI model default capabilities" });
suite.define(() => {
  it.each([1440, 390])("aligns defaults and saves capability choices at %ipx", async (width) => {
    await suite.withPage(
      { viewport: { width, height: 1100 }, locale: "en-US" },
      async ({ page }) => {
        const config = {
          agents: {
            defaults: {
              model: "openai/gpt-4.1",
              thinkingDefault: "max",
              fastModeDefault: "ultrafast",
            },
          },
        };
        const models = [
          {
            provider: "openai",
            id: "gpt-4.1",
            name: "QA model with a deliberately long descriptive label",
            available: true,
            reasoning: true,
            thinkingLevels: [
              { id: "low", label: "Low" },
              { id: "max", label: "Max" },
              { id: "ultra", label: "Ultra" },
            ],
            supportsFastMode: true,
            serviceTiers: ["priority", "ultrafast"],
          },
        ];
        const gateway = await installMockGateway(page, {
          assistantName: "QA Assistant",
          models,
          methodResponses: {
            "config.get": {
              config,
              sourceConfig: config,
              hash: "qa-defaults",
              valid: true,
              issues: [],
              raw: JSON.stringify(config),
            },
            "models.authStatus": {
              ts: 1,
              providers: [{ provider: "openai", profiles: [], apiKey: { source: "config" } }],
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/model-providers`);
        await waitForControlUiRoute(page, { routeId: "model-providers" });
        const defaults = page.locator(".model-providers__defaults");
        const pickers = defaults.locator(".model-picker .picker-select__trigger");
        await expect.poll(() => pickers.first().textContent()).toContain(models[0]!.name);
        const frame = await takeControlUiScreenshotFrame(page, defaults, [pickers.first()], {
          animations: "disabled",
          scrollTo: defaults,
          elements: [defaults],
        });
        await writeFile(path.join(suite.artifactDir, `defaults-${width}.png`), frame.png);
        const boxes = await pickers.evaluateAll((elements) =>
          elements.map((element) => {
            const box = element.getBoundingClientRect();
            return { left: box.left, width: box.width, height: box.height };
          }),
        );
        expect(boxes).toHaveLength(4);
        for (const box of boxes) {
          expect(Math.abs(box.left - boxes[0]!.left)).toBeLessThan(1);
          expect(Math.abs(box.width - boxes[0]!.width)).toBeLessThan(1);
          expect(Math.abs(box.height - boxes[0]!.height)).toBeLessThan(1);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        const thinking = defaults.getByRole("radiogroup", { name: "Thinking", exact: true });
        const speed = defaults.getByRole("radiogroup", { name: "Fast Mode", exact: true });
        expect(await speed.getByRole("radio", { name: "Ultrafast", exact: true }).isChecked()).toBe(
          true,
        );
        await gateway.deferNext("config.patch");
        await thinking.getByRole("radio", { name: "Ultra", exact: true }).check();
        const request = await gateway.waitForRequest("config.patch");
        expect(requestRaw(request)).toMatchObject({
          agents: { defaults: { thinkingDefault: "ultra", fastModeDefault: "ultrafast" } },
        });
        const saved = {
          agents: { defaults: { ...config.agents.defaults, thinkingDefault: "ultra" } },
        };
        await resolveConfigMutation(gateway, saved, "qa-ultra");
        await expect
          .poll(() => thinking.getByRole("radio", { name: "Ultra", exact: true }).isEnabled())
          .toBe(true);
        await gateway.deferNext("config.patch");
        await speed.getByRole("radio", { name: "Default", exact: true }).check();
        await expect.poll(async () => (await gateway.getRequests("config.patch")).length).toBe(2);
        expect(requestRaw((await gateway.getRequests("config.patch"))[1]!)).toMatchObject({
          agents: { defaults: { thinkingDefault: "ultra", fastModeDefault: null } },
        });
        await resolveConfigMutation(
          gateway,
          { agents: { defaults: { model: "openai/gpt-4.1", thinkingDefault: "ultra" } } },
          "qa-inherited",
        );
        await expect
          .poll(() => speed.getByRole("radio", { name: "Default", exact: true }).isChecked())
          .toBe(true);
        await expect
          .poll(() => speed.getByRole("radio", { name: "Ultrafast", exact: true }).isEnabled())
          .toBe(true);
        await gateway.deferNext("config.patch");
        await speed.getByRole("radio", { name: "Ultrafast", exact: true }).check();
        await expect.poll(async () => (await gateway.getRequests("config.patch")).length).toBe(3);
        expect(requestRaw((await gateway.getRequests("config.patch"))[2]!)).toMatchObject({
          agents: { defaults: { fastModeDefault: "ultrafast" } },
        });
        await resolveConfigMutation(gateway, saved, "qa-ultrafast");
        await expect
          .poll(() => speed.getByRole("radio", { name: "Ultrafast", exact: true }).isChecked())
          .toBe(true);
      },
    );
  });
});
