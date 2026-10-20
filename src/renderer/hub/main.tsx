import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource/caveat/600.css';
import '@fontsource/caveat/700.css';
import '../ui/base.css';
import './hub.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(<App />);
