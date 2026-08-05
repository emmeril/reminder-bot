const assert = require("node:assert/strict");
const test = require("node:test");

const { runScheduledTasks } = require("../src/app");

test("kegagalan satu scheduled task tidak menggagalkan task lainnya", async () => {
  let secondTaskRan = false;
  const logs = [];

  const results = await runScheduledTasks([
    {
      name: "whatsapp-task",
      run: async () => {
        throw new Error("WhatsApp gagal");
      },
    },
    {
      name: "core-task",
      run: async () => {
        secondTaskRan = true;
        return "selesai";
      },
    },
  ], {
    push(...args) {
      logs.push(args);
    },
  });

  assert.equal(secondTaskRan, true);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[1].status, "fulfilled");
  assert.equal(results[1].value, "selesai");
  assert.match(logs[0][2], /whatsapp-task.*WhatsApp gagal/);
});
