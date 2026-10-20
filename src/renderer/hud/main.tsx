import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '../ui/base.css';
import './hud.css';
import { Hud } from './Hud';

createRoot(document.getElementById('root')!).render(<Hud />);
