import { chromium } from 'playwright';
import 'dotenv/config';

async function testScraping() {
    // 1. Usamos un contexto persistente. 
    // Esto crea una carpeta local para guardar tus cookies, así solo inicias sesión en Google una vez.
    const userDataDir = './perfil_chrome_test';
    const browser = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        channel: 'chrome', // ¡La clave! Esto obliga a usar tu Google Chrome real instalado en el sistema
        args: [
            '--disable-blink-features=AutomationControlled', // Oculta la bandera de "navegador automatizado"
            '--no-default-browser-check',
            '--no-first-run'
        ]
    });
    const page = await browser.newPage();
    
    // ⚠️ REEMPLAZA ESTO con la URL de tu cuaderno real de NotebookLM
    // 'https://notebooklm.google.com/notebook/TU_ID_AQUI'
    const NOTEBOOK_URL = process.env.NLM_NOTEBOOK_URL; 
    
    console.log('🌐 Navegando a NotebookLM...');
    await page.goto(NOTEBOOK_URL);

    // 2. Esperar al input del chat (Selector extraído de browser-session.ts)
    const inputSelector = 'textarea.query-box-input';
    
    console.log('⏳ Esperando a que cargue la interfaz...');
    console.log('💡 Si es tu primera vez, inicia sesión en Google en la ventana del navegador. El script esperará.');
    
    // Timeout en 0 significa que esperará indefinidamente hasta que te loguees y cargue el cuaderno
    await page.waitForSelector(inputSelector, { state: 'visible', timeout: 0 });
    console.log('✅ Interfaz lista.');

    // 3. Hacer la pregunta
    const pregunta = 'Hazme un resumen muy breve de los documentos.';
    console.log(`💬 Preguntando: "${pregunta}"`);
    await page.fill(inputSelector, pregunta);
    await page.keyboard.press('Enter');

    // 4. Extraer la respuesta (Lógica simplificada de page-utils.ts)
    console.log('⏳ Esperando la respuesta de la IA...');
    
    // Damos un tiempo arbitrario para que termine de generar (en el MCP real usan un polling complejo)
    // Para la prueba, 15 segundos deberían bastar para una respuesta corta.
    await page.waitForTimeout(15000); 

    const respuestaExtraida = await page.evaluate(() => {
        // Selector principal de page-utils.ts
        const containers = document.querySelectorAll('.to-user-container');
        if (containers.length === 0) return "No se encontraron contenedores de respuesta.";

        // Tomamos el último contenedor (la respuesta más reciente)
        const ultimoContenedor = containers[containers.length - 1];
        const textElement = ultimoContenedor.querySelector('.message-text-content');
        
        return textElement ? textElement.innerText : "No se encontró el texto dentro del contenedor.";
    });

    console.log('\n--- 📄 RESPUESTA EXTRAÍDA ---');
    console.log(respuestaExtraida);
    console.log('-----------------------------\n');

    console.log('🛑 Cerrando navegador...');
    await browser.close();
}

testScraping().catch(console.error);