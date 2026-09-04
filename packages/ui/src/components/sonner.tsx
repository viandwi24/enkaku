'use client'

import { Toaster as Sonner, type ToasterProps } from 'sonner'
import { CheckCircleIcon, CircleNotchIcon, InfoIcon, WarningIcon, XCircleIcon } from '../icons'
import { useResolvedTheme } from '../lib/theme'

const Toaster = ({ ...props }: ToasterProps) => {
  const theme = useResolvedTheme()

  return (
    <Sonner
      theme={theme}
      className="toaster group"
      icons={{
        success: <CheckCircleIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <WarningIcon className="size-4" />,
        error: <XCircleIcon className="size-4" />,
        loading: <CircleNotchIcon className="size-4 animate-enkaku-spin" />,
      }}
      style={
        {
          '--normal-bg': 'var(--panel)',
          '--normal-text': 'var(--text)',
          '--normal-border': 'var(--border-2)',
          '--border-radius': '10px',
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
