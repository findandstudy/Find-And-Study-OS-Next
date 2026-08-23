import { CheckCircle2, AlertCircle, AlertTriangle, Info } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "@/components/ui/toast"

const ICONS: Record<string, React.ElementType> = {
  default: Info,
  destructive: AlertCircle,
  success: CheckCircle2,
  warning: AlertTriangle,
}

export function Toaster() {
  const { toasts } = useToast()

  return (
    <ToastProvider>
      {toasts.map(function ({ id, title, description, action, variant, ...props }) {
        const Icon = ICONS[(variant as string) ?? "default"] ?? Info
        return (
          <Toast key={id} variant={variant} {...props}>
            <div className="toast-accent absolute left-0 top-0 bottom-0 w-1 rounded-l-xl" />
            <div className="toast-icon-wrap flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center ml-1">
              <Icon className="w-4 h-4" />
            </div>
            <div className="flex-1 min-w-0">
              {title && <ToastTitle>{title}</ToastTitle>}
              {description && <ToastDescription>{description}</ToastDescription>}
            </div>
            {action}
            <ToastClose />
          </Toast>
        )
      })}
      <ToastViewport />
    </ToastProvider>
  )
}
