const VARIANT_STYLES = {
  info: 'border-blue-200 bg-blue-50 text-blue-800',
  warning: 'border-amber-200 bg-amber-50 text-amber-800',
  danger: 'border-red-200 bg-red-50 text-red-800'
}

export default function Banner({ variant = 'info', children }) {
  return (
    <div className={`rounded-md border px-3 py-2 text-sm ${VARIANT_STYLES[variant]}`}>
      {children}
    </div>
  )
}
