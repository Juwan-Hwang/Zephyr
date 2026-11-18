import { $, $$, until, wait } from './_kit.js';

export async function openEditDialog(index = 0) {
  await until(() => $$('.sub-action-btn').length > 0, 6000);
  const btns = $$('.sub-action-btn').filter((b) => /编辑/.test(b.title || ''));
  (btns[index] || btns[0])?.click();
  const modal = await until(() => $('#edit-subscription-modal'));
  await wait(450);
  return modal;
}
