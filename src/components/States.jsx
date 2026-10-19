export function Loading({ label }) {
  return (
    <p className="state state-loading" role="status">
      <span className="state-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {label}
    </p>
  )
}

function StateBlock({ tone, level, title, detail, children, role }) {
  const Title = `h${level}`
  return (
    <div className={`state state-${tone}`} role={role}>
      <Title className="state-title">{title}</Title>
      {detail && <p className="state-detail">{detail}</p>}
      {children && <div className="state-actions">{children}</div>}
    </div>
  )
}

export function ErrorState({ title, detail, level = 1, children }) {
  return (
    <StateBlock tone="error" level={level} title={title} detail={detail} role="alert">
      {children}
    </StateBlock>
  )
}

export function EmptyState({ title, detail, level = 1, children }) {
  return (
    <StateBlock tone="empty" level={level} title={title} detail={detail}>
      {children}
    </StateBlock>
  )
}
