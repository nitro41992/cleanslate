import { Monitor } from 'lucide-react'

export function MobileBlocker() {
  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-background p-8 md:hidden">
      <div className="text-center max-w-sm">
        <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-6">
          <Monitor className="w-8 h-8 text-primary" />
        </div>
        <h1 className="text-2xl font-semibold mb-3">Desktop Required</h1>
        <p className="text-muted-foreground leading-relaxed">
          CleanSlate is designed for desktop browsers to handle large datasets effectively.
          Please access this application from a device with a screen width of at least 768px.
        </p>
        <div className="mt-8 text-xs text-muted-foreground/60">
          Built for data professionals who need power tools
        </div>
      </div>
    </div>
  )
}
