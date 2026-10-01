import { afterAll, describe, expect, it } from 'vitest';
import { BASE, closeBrowser, closeDb, db, eventually, newVisitor, orgBySlug, signInStaff } from './helpers';

afterAll(async () => {
  await closeBrowser();
  await closeDb();
});

describe('console: website', () => {
  it('a manager edits a page as a draft, the live page is untouched until they publish, then it is live', async () => {
    const { orgId } = await orgBySlug('oak-diner');
    const page = await db()
      .selectFrom('pages')
      .select(['id', 'blocks', 'published_at'])
      .where('org_id', '=', orgId)
      .where('venue_id', 'is', null)
      .where('slug', '=', 'about')
      .where('status', '=', 'published')
      .executeTakeFirstOrThrow();
    const words = `Fresh from the e2e kitchen ${Date.now().toString(36)}.`;

    const v = await newVisitor();
    await signInStaff(v.page, 'manager@oak-diner.test');
    await v.page.goto(`${BASE()}/console/website`);
    await v.page.getByRole('link', { name: 'About', exact: true }).click();
    await v.page.waitForURL(new RegExp(`/console/website/pages/${page.id}$`));

    // The first "About" section: replace its text and save it to the draft.
    const section = v.page.locator('section', { has: v.page.getByRole('heading', { name: /^About$/ }) }).first();
    await section.locator('textarea[name=body]').fill(words);
    await section.getByRole('button', { name: 'Save section' }).click();
    await section.getByText('Section saved to the draft.').waitFor();

    const drafted = await db().selectFrom('pages').select(['blocks', 'draft', 'published_at']).where('id', '=', page.id).executeTakeFirstOrThrow();
    expect(JSON.stringify(drafted.draft)).toContain(words);
    expect(JSON.stringify(drafted.blocks)).not.toContain(words);
    expect(drafted.published_at?.getTime()).toBe(page.published_at?.getTime());
    await v.page.getByText('Unpublished changes').first().waitFor();

    await v.page.getByTestId('publish-page').click();
    const confirm = v.page.locator('dialog[open]');
    await confirm.getByText('The live page is replaced by this draft').waitFor();
    await confirm.getByRole('button', { name: 'Publish now' }).click();
    await confirm.getByText('Published. The page is live on the site.').waitFor();

    const live = await eventually(
      () => db().selectFrom('pages').select(['blocks', 'draft', 'status', 'published_at']).where('id', '=', page.id).where('draft', 'is', null).executeTakeFirst(),
      'the draft published',
    );
    expect(live.status).toBe('published');
    expect(JSON.stringify(live.blocks)).toContain(words);
    expect(live.published_at!.getTime()).toBeGreaterThan(page.published_at!.getTime());
    const audit = await db().selectFrom('audit_log').select(['actor_kind', 'after']).where('action', '=', 'page.published').where('entity_id', '=', page.id).orderBy('occurred_at', 'desc').executeTakeFirstOrThrow();
    expect(audit.actor_kind).toBe('staff');
    expect(JSON.stringify(audit.after)).toContain(words);
    const event = await db().selectFrom('events').select('properties').where('name', '=', 'page.published').where('org_id', '=', orgId).orderBy('occurred_at', 'desc').executeTakeFirstOrThrow();
    expect(event.properties).toMatchObject({ page_id: page.id, via: 'console' });
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('a manager creates a page, adds a section and publishes it; deleting it asks first', async () => {
    const { orgId } = await orgBySlug('oak-diner');
    const slug = `e2e-${Date.now().toString(36)}`;
    const v = await newVisitor();
    await signInStaff(v.page, 'manager@oak-diner.test');
    await v.page.goto(`${BASE()}/console/website`);
    await v.page.getByRole('button', { name: 'New page' }).click();
    const dialog = v.page.locator('dialog[open]');
    await dialog.locator('input[name=title]').fill('Private dining');
    await dialog.locator('input[name=slug]').fill(slug);
    await dialog.getByRole('button', { name: 'Create draft' }).click();
    await v.page.waitForURL(/\/console\/website\/pages\/[0-9a-f-]{36}$/);
    const created = await db().selectFrom('pages').select(['id', 'status']).where('org_id', '=', orgId).where('slug', '=', slug).executeTakeFirstOrThrow();
    expect(created.status).toBe('draft');

    // Publishing an empty page is refused, in words.
    await v.page.getByTestId('publish-page').click();
    await v.page.locator('dialog[open]').getByRole('button', { name: 'Publish now' }).click();
    await v.page.locator('dialog[open]').getByText('Add at least one section before publishing.').waitFor();
    await v.page.locator('dialog[open]').getByRole('button', { name: 'Cancel' }).click();

    await v.page.locator('select[name=type]').selectOption('faq');
    await v.page.getByRole('button', { name: 'Add to the end' }).click();
    await v.page.locator('input[name="items.question"]').first().waitFor();
    await v.page.getByTestId('publish-page').click();
    await v.page.locator('dialog[open]').getByRole('button', { name: 'Publish now' }).click();
    await eventually(() => db().selectFrom('pages').select('id').where('id', '=', created.id).where('status', '=', 'published').executeTakeFirst(), 'the new page published');

    await v.page.reload();
    await v.page.getByRole('button', { name: 'Delete', exact: true }).click();
    await v.page.locator('dialog[open]').getByText('deleted for good').waitFor();
    await v.page.locator('dialog[open]').getByRole('button', { name: 'Delete page' }).click();
    await v.page.waitForURL(/\/console\/website$/);
    expect(await db().selectFrom('pages').select('id').where('id', '=', created.id).executeTakeFirst()).toBeUndefined();
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('front-of-house staff do not get the website editor', async () => {
    const v = await newVisitor();
    await signInStaff(v.page, 'host@oak-diner.test');
    expect(await v.page.getByRole('link', { name: 'Website' }).count()).toBe(0);
    await v.page.goto(`${BASE()}/console/website`);
    await v.page.getByText('Your role does not include this').waitFor();
    expect(v.problems).toEqual([]);
    await v.context.close();
  });
});
