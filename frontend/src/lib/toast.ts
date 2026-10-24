import { createContext, useContext } from 'react'

export type ToastType = 'success' | 'error' | 'info'
export type Toast = { id: number; type: ToastType; message: string; action?: { label: string; onClick: () => void } }
export type ToastApi = (message: string, type?: ToastType, action?: Toast['action']) => void

export const ToastContext = createContext<ToastApi>(() => {})

/** Show a transient, screen-reader-announced notification. */
export function useToast() { return useContext(ToastContext) }
