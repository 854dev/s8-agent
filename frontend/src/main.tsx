import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MantineProvider, createTheme } from '@mantine/core'
import '@mantine/core/styles.css'
import '@fontsource/ibm-plex-sans-kr/400.css'
import '@fontsource/ibm-plex-sans-kr/500.css'
import '@fontsource/ibm-plex-sans-kr/600.css'
import './index.css'
import App from './App.tsx'

const theme = createTheme({
  fontFamily: 'IBM Plex Sans KR, sans-serif',
  primaryColor: 'dark',
  primaryShade: 9,
  colors: { dark: ['#f4f4f4', '#e0e0e0', '#c6c6c6', '#a8a8a8', '#8d8d8d', '#6f6f6f', '#525252', '#393939', '#262626', '#161616'] },
  defaultRadius: 0,
  headings: {
    fontWeight: '400',
    fontFamily: 'IBM Plex Sans KR, sans-serif',
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MantineProvider theme={theme} forceColorScheme="light">
      <App />
    </MantineProvider>
  </StrictMode>,
)
