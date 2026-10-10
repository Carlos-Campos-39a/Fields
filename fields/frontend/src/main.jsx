import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import Gate from "./auth/Gate.jsx";
import { OntologiaProvider } from "./lib/ontologia.js";
import { iniciarTema } from "./theme/theme.js";
import { ToastProvider } from "./ui/index.js";
import "./index.css";

// O script inline do index.html já pintou o tema certo; daqui em diante o módulo acompanha a troca
// de preferência, o sistema (preferência "system") e as outras abas. Uma vez, antes do render.
iniciarTema();

// ToastProvider por fora do Gate: o aviso de "sessão expirou" e os da tela de login também cabem
// nele. OntologiaProvider por dentro: GET /api/ontologia exige sessão.
ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ToastProvider>
      <Gate>
        <OntologiaProvider>
          <App />
        </OntologiaProvider>
      </Gate>
    </ToastProvider>
  </React.StrictMode>
);
