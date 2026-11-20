import { expect, test } from '@playwright/test';

test('create, share, format and recover offline edits from IndexedDB', async ({ browser, page }) => {
  const second = await browser.newContext();
  try {
    const remote = await second.newPage();
    const title = `Pair notes ${Date.now()}`;
    await page.goto('/');
    await page.getByLabel('Document title').fill(title);
    await page.getByRole('button', { name: 'Create document' }).click();
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    const url = page.url();
    await remote.goto(url);
    const localEditor = page.getByRole('textbox', { name: 'Document content' });
    const remoteEditor = remote.getByRole('textbox', { name: 'Document content' });
    await expect(page.getByText('Live', { exact: true })).toBeVisible();
    await expect(page.getByText('Browser storage ready')).toBeVisible();
    await expect(remote.getByText('2 online')).toBeVisible();
    await page.getByLabel('Your display name').fill('Mia');
    await page.getByRole('button', { name: 'Update name' }).click();
    await expect(remote.getByText('Mia', { exact: true }).first()).toBeVisible();

    await page.getByRole('button', { name: 'Bold' }).click();
    await localEditor.pressSequentially('Shared');
    await expect(remoteEditor.locator('strong')).toHaveText('Shared');
    await expect(remoteEditor.locator('.collaboration-carets__caret')).toHaveCount(1);

    const context = page.context();
    await context.setOffline(true);
    await expect(page.getByText('Offline', { exact: true })).toBeVisible();
    await expect(remote.getByText('1 online')).toBeVisible();
    await localEditor.press('End');
    await localEditor.pressSequentially(' offline-A', { delay: 20 });
    await remoteEditor.press('End');
    await remoteEditor.pressSequentially(' online-B');
    await expect(remoteEditor).toHaveText('Shared online-B');
    await page.close();

    await context.setOffline(false);
    const reopened = await context.newPage();
    await reopened.goto(url);
    const recovered = reopened.getByRole('textbox', { name: 'Document content' });
    await expect(remoteEditor).toContainText('offline-A');
    await expect(recovered).toContainText('online-B');
    await expect(recovered).toHaveText(await remoteEditor.innerText());
  } finally {
    await second.close();
  }
});
