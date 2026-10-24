
type PlaceholderPageProps = {
  title: string
  description: string
}

export default function PlaceholderPage({
  title,
  description,
}: PlaceholderPageProps) {
  return (
    <section className="space-y-4">
      <h1 className="text-3xl font-bold">{title}</h1>
      <p style={{ color: 'var(--color-text-muted)' }}>
        {description}
      </p>
      <div
        className="rounded-3xl border p-8"
        style={{
          background: 'var(--color-surface)',
          borderColor: 'var(--color-border)',
        }}
      >
        {title}
      </div>
    </section>
  )
}
