/**
 * A titled block of related settings on a settings page.
 *
 * Rows used to sit in one flat list, which left the reader to infer which of
 * them applied to the whole extension and which only to the side panel. The
 * grouping carries that distinction visually.
 */
export function SettingsGroup({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h3>
      <div className="space-y-5 pl-0.5">{children}</div>
    </section>
  );
}
