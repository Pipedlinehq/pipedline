import type { ReactNode } from 'react';
import { Checkbox, Field, Input, Select, Textarea } from '@/ui';
import type { Block } from './block-form';

/**
 * The fields for one block. Lists (gallery images, testimonials, questions, paragraphs) show every
 * existing row plus one empty row to add another; clearing a row's main field removes it.
 */

const Row = ({ children }: { children: ReactNode }) => <div className="grid gap-3 sm:grid-cols-2">{children}</div>;

function Heading({ value, required, label = 'Heading' }: { value: string | null | undefined; required?: boolean; label?: string }) {
  return (
    <Field label={label} hint={required ? undefined : 'Optional.'}>
      <Input name="heading" maxLength={120} required={required} defaultValue={value ?? ''} />
    </Field>
  );
}

function Image({ url, alt }: { url: string | null; alt: string | null }) {
  return (
    <Row>
      <Field label="Image address" hint="From Media, or a full https:// address. Optional.">
        <Input name="imageUrl" defaultValue={url ?? ''} />
      </Field>
      <Field label="Image description" hint="Read aloud to people who cannot see it.">
        <Input name="imageAlt" maxLength={200} defaultValue={alt ?? ''} />
      </Field>
    </Row>
  );
}

export function BlockFields({ block, mediaUrls }: { block: Block; mediaUrls: string[] }) {
  const media = mediaUrls.length ? (
    <datalist id={`media-${block.id}`}>
      {mediaUrls.map((u) => (
        <option key={u} value={u} />
      ))}
    </datalist>
  ) : null;
  switch (block.type) {
    case 'hero':
      return (
        <div className="space-y-3">
          <Heading value={block.heading} required />
          <Field label="Subheading" hint="Optional.">
            <Input name="subheading" maxLength={240} defaultValue={block.subheading ?? ''} />
          </Field>
          <Image url={block.imageUrl} alt={block.imageAlt} />
          <Row>
            <Field label="Button words" hint="Optional.">
              <Input name="ctaLabel" maxLength={40} defaultValue={block.ctaLabel ?? ''} />
            </Field>
            <Field label="Button goes to" hint="Empty: the venue's order or booking page.">
              <Input name="ctaHref" defaultValue={block.ctaHref ?? ''} placeholder="/menu" />
            </Field>
          </Row>
        </div>
      );
    case 'about':
      return (
        <div className="space-y-3">
          <Heading value={block.heading} />
          <Field label="Text" hint="Plain text. A blank line starts a new paragraph.">
            <Textarea name="body" required maxLength={4000} rows={6} defaultValue={block.body} />
          </Field>
          <Image url={block.imageUrl} alt={block.imageAlt} />
        </div>
      );
    case 'menu':
      return (
        <div className="space-y-3">
          <p className="text-xs text-ink-3">The dishes come from the live menu, so an 86&apos;d item disappears here too.</p>
          <Heading value={block.heading} />
          <Field label="Introduction" hint="Optional.">
            <Textarea name="intro" maxLength={600} defaultValue={block.intro ?? ''} />
          </Field>
          <Row>
            <Field label="Show">
              <Select name="display" defaultValue={block.display}>
                <option value="full">The whole menu</option>
                <option value="highlights">A few highlights</option>
              </Select>
            </Field>
            <Field label="How many highlights">
              <Input name="itemLimit" type="number" min={1} max={24} defaultValue={block.itemLimit} />
            </Field>
          </Row>
          <Checkbox name="showPrices" label="Show prices" defaultChecked={block.showPrices} />
        </div>
      );
    case 'gallery':
      return (
        <div className="space-y-3">
          <Heading value={block.heading} />
          {media}
          {[...block.images, { url: '', alt: '', caption: null }].map((img, i) => (
            <fieldset key={i} className="grid gap-3 rounded-md border border-line p-3 sm:grid-cols-3">
              <legend className="px-1 text-xs text-ink-3">{i < block.images.length ? `Photo ${i + 1}` : 'Add a photo'}</legend>
              <Field label="Address">
                <Input name="images.url" defaultValue={img.url} list={mediaUrls.length ? `media-${block.id}` : undefined} />
              </Field>
              <Field label="Description">
                <Input name="images.alt" maxLength={200} defaultValue={img.alt} />
              </Field>
              <Field label="Caption">
                <Input name="images.caption" maxLength={200} defaultValue={img.caption ?? ''} />
              </Field>
            </fieldset>
          ))}
          <p className="text-xs text-ink-3">Clear a photo&apos;s address to take it out.</p>
        </div>
      );
    case 'hours-location':
      return (
        <div className="space-y-3">
          <p className="text-xs text-ink-3">The address and hours come from the venue&apos;s details and Hours.</p>
          <Heading value={block.heading} />
          <Field label="Note" hint="Optional, e.g. parking.">
            <Textarea name="note" maxLength={400} defaultValue={block.note ?? ''} />
          </Field>
          <Checkbox name="showMap" label="Show a map" defaultChecked={block.showMap} />
        </div>
      );
    case 'booking-cta':
    case 'order-cta':
      return (
        <div className="space-y-3">
          <Heading value={block.heading} required />
          <Field label="Text" hint="Optional.">
            <Textarea name="body" maxLength={600} defaultValue={block.body ?? ''} />
          </Field>
          <Row>
            <Field label="Button words">
              <Input name="label" required maxLength={40} defaultValue={block.label} />
            </Field>
            <Field label="Button goes to" hint="Empty: the venue's own setting.">
              <Input name="href" defaultValue={block.href ?? ''} />
            </Field>
          </Row>
        </div>
      );
    case 'testimonials':
      return (
        <div className="space-y-3">
          <Heading value={block.heading} />
          {[...block.items, { quote: '', author: '', source: null }].map((t, i) => (
            <fieldset key={i} className="space-y-2 rounded-md border border-line p-3">
              <legend className="px-1 text-xs text-ink-3">{i < block.items.length ? `Quote ${i + 1}` : 'Add a quote'}</legend>
              <Field label="Quote">
                <Textarea name="items.quote" maxLength={600} defaultValue={t.quote} />
              </Field>
              <Row>
                <Field label="Who said it">
                  <Input name="items.author" maxLength={80} defaultValue={t.author} />
                </Field>
                <Field label="Where" hint="Optional.">
                  <Input name="items.source" maxLength={80} defaultValue={t.source ?? ''} />
                </Field>
              </Row>
            </fieldset>
          ))}
        </div>
      );
    case 'faq':
      return (
        <div className="space-y-3">
          <Heading value={block.heading} />
          {[...block.items, { question: '', answer: '' }].map((q, i) => (
            <fieldset key={i} className="space-y-2 rounded-md border border-line p-3">
              <legend className="px-1 text-xs text-ink-3">{i < block.items.length ? `Question ${i + 1}` : 'Add a question'}</legend>
              <Field label="Question">
                <Input name="items.question" maxLength={200} defaultValue={q.question} />
              </Field>
              <Field label="Answer">
                <Textarea name="items.answer" maxLength={1500} defaultValue={q.answer} />
              </Field>
            </fieldset>
          ))}
        </div>
      );
    case 'contact':
      return (
        <div className="space-y-3">
          <p className="text-xs text-ink-3">Phone, email and address come from the venue&apos;s details.</p>
          <Heading value={block.heading} />
          <Field label="Text" hint="Optional.">
            <Textarea name="body" maxLength={800} defaultValue={block.body ?? ''} />
          </Field>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <Checkbox name="showPhone" label="Phone" defaultChecked={block.showPhone} />
            <Checkbox name="showEmail" label="Email" defaultChecked={block.showEmail} />
            <Checkbox name="showAddress" label="Address" defaultChecked={block.showAddress} />
          </div>
        </div>
      );
    case 'rich-text':
      return (
        <div className="space-y-3">
          <Heading value={block.heading} />
          {[...block.paragraphs, { kind: 'paragraph' as const, text: '' }].map((p, i) => {
            const text = p.kind === 'list' ? p.items.join('\n') : p.text;
            return (
              <fieldset key={i} className="space-y-2 rounded-md border border-line p-3">
                <legend className="px-1 text-xs text-ink-3">{i < block.paragraphs.length ? `Part ${i + 1}` : 'Add a part'}</legend>
                <Field label="Kind">
                  <Select name="p.kind" defaultValue={p.kind} className="max-w-48">
                    <option value="paragraph">Paragraph</option>
                    <option value="subheading">Subheading</option>
                    <option value="quote">Quote</option>
                    <option value="list">List (one item per line)</option>
                  </Select>
                </Field>
                <Field label="Words">
                  <Textarea name="p.text" maxLength={3000} defaultValue={text} />
                </Field>
                <Field label="Quote attributed to" hint="Quotes only. Optional.">
                  <Input name="p.attribution" maxLength={120} defaultValue={p.kind === 'quote' ? (p.attribution ?? '') : ''} />
                </Field>
              </fieldset>
            );
          })}
        </div>
      );
    case 'instagram-feed':
      return (
        <div className="space-y-3">
          <Heading value={block.heading} />
          <Row>
            <Field label="Instagram handle" hint="Without the @.">
              <Input name="handle" required maxLength={30} defaultValue={block.handle} />
            </Field>
            <Field label="Posts shown">
              <Input name="count" type="number" min={3} max={12} defaultValue={block.count} />
            </Field>
          </Row>
        </div>
      );
    case 'criota-reel':
      return (
        <div className="space-y-3">
          <Heading value={block.heading} />
          <Row>
            <Field label="Campaign id" hint="Optional: only this campaign's videos.">
              <Input name="campaignId" maxLength={64} defaultValue={block.campaignId ?? ''} />
            </Field>
            <Field label="Videos shown">
              <Input name="limit" type="number" min={1} max={12} defaultValue={block.limit} />
            </Field>
          </Row>
          <Field label="Layout">
            <Select name="layout" defaultValue={block.layout} className="max-w-48">
              <option value="carousel">Carousel</option>
              <option value="grid">Grid</option>
            </Select>
          </Field>
        </div>
      );
  }
}
