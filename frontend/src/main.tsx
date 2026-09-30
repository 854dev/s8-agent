import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MantineProvider, createTheme } from '@mantine/core'
import '@mantine/core/styles.css'
import './index.css'
import App from './App.tsx'

const theme = createTheme({
  fontFamily: 'Inter, Pretendard, system-ui, sans-serif',
  primaryColor: 'dark',
  defaultRadius: 'md',
  headings: {
    fontFamily: 'Inter, Pretendard, system-ui, sans-serif',
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="auto">
      <App />
    </MantineProvider>
  </StrictMode>,
)
