import { chromium } from 'playwright';
import 'dotenv/config';
import fs from 'fs';

async function testScraping() {
    const userDataDir = './perfil_chrome_test';
    const browser = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        channel: 'chrome',
        args: [
            '--disable-blink-features=AutomationControlled',
            '--no-default-browser-check',
            '--no-first-run'
        ]
    });

    const page = await browser.newPage();
    const NOTEBOOK_URL = process.env.NLM_NOTEBOOK_URL; 
    
    const ENVIAR_NUEVA_PREGUNTA = false; 
    const pregunta = 'Hazme un resumen muy breve de los documentos.';

    console.log('🌐 Navegando a NotebookLM...');
    await page.goto(NOTEBOOK_URL);

    const inputSelector = 'textarea.query-box-input';
    console.log('⏳ Esperando a que cargue la interfaz...');
    await page.waitForSelector(inputSelector, { state: 'visible', timeout: 0 });
    console.log('✅ Interfaz lista.');

    if (ENVIAR_NUEVA_PREGUNTA) {
        console.log(`💬 Preguntando: "${pregunta}"`);
        await page.fill(inputSelector, pregunta);
        await page.keyboard.press('Enter');
        console.log('⏳ Esperando la respuesta (15 segundos)...');
        await page.waitForTimeout(15000); 
    } else {
        console.log('⏭️ Omitiendo nueva consulta. Usando el historial existente...');
        await page.waitForSelector('.to-user-container', { state: 'visible' });
        await page.waitForTimeout(2000); 
    }

    const ultimoContenedor = page.locator('.to-user-container').last();

    console.log('🔍 Buscando citas agrupadas para expandir...');
    const posiblesExpansores = await ultimoContenedor.locator('button.citation-marker').all();
    
    for (const expansor of posiblesExpansores) {
        const textoExpansor = await expansor.innerText();
        if (textoExpansor.trim() === '...') {
            console.log('   🔄 Expandiendo grupo de citas ocultas...');
            await expansor.scrollIntoViewIfNeeded();
            await expansor.click();
            await page.waitForTimeout(800);
        }
    }

    // --- PARTE 1: Extraer y limpiar el HTML principal ---
    const textoPrincipalHTML = await page.evaluate(() => {
        const containers = document.querySelectorAll('.to-user-container');
        if (containers.length === 0) return "<p>No se encontraron contenedores.</p>";

        const ultimoContenedorDOM = containers[containers.length - 1];
        const textElement = ultimoContenedorDOM.querySelector('.message-text-content');
        if (!textElement) return "<p>Sin texto.</p>";

        const clone = textElement.cloneNode(true);
        
        const markers = clone.querySelectorAll('button.citation-marker');
        markers.forEach(marker => {
            const texto = marker.innerText.trim();
            if (texto === '...' || texto === '><' || texto === '> <') {
                marker.remove();
            } else {
                const textoLimpio = document.createTextNode(` [${texto}]`);
                marker.parentNode.replaceChild(textoLimpio, marker);
            }
        });

        // 🧹 --- FUNCIÓN DE LIMPIEZA DOM MEJORADA ---
        const limpiarHTML = (node) => {
            // 1. Eliminar comentarios HTML
            const walker = document.createTreeWalker(node, NodeFilter.SHOW_COMMENT, null, false);
            const comments = [];
            let cNode;
            while (cNode = walker.nextNode()) comments.push(cNode);
            comments.forEach(c => c.remove());

            // 2. 🟢 NUEVO: Convertir saltos de línea físicos (\n) en etiquetas <br>
            const textWalker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null, false);
            const textNodes = [];
            let tNode;
            while (tNode = textWalker.nextNode()) textNodes.push(tNode);
            
            textNodes.forEach(t => {
                if (t.nodeValue.includes('\n')) {
                    const fragment = document.createDocumentFragment();
                    const parts = t.nodeValue.split('\n');
                    parts.forEach((part, i) => {
                        if (part) fragment.appendChild(document.createTextNode(part));
                        if (i < parts.length - 1) {
                            fragment.appendChild(document.createElement('br'));
                        }
                    });
                    t.parentNode.replaceChild(fragment, t);
                }
            });

            // 3. Desenvolver etiquetas basura
            const badTags = ['labs-tailwind-structural-element-view-v2', 'element-list-renderer'];
            badTags.forEach(tag => {
                node.querySelectorAll(tag).forEach(el => {
                    while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
                    el.remove();
                });
            });

            // 4. Limpiar atributos basura
            node.querySelectorAll('*').forEach(el => {
                Array.from(el.attributes).forEach(attr => {
                    if (attr.name !== 'href' && attr.name !== 'src') {
                        el.removeAttribute(attr.name);
                    }
                });
            });

            return node.innerHTML.trim();
        };

        return limpiarHTML(clone);
    });

    // --- PARTE 2: Interactuar con las burbujas ---
    console.log('\n🔍 Recopilando citas referenciadas reales...');
    const referencias = [];
    const todosLosMarcadores = await ultimoContenedor.locator('button.citation-marker').all();
    const marcadoresValidos = [];

    for (const marker of todosLosMarcadores) {
        const text = await marker.innerText();
        const textoLimpio = text.trim();
        if (textoLimpio !== '...' && textoLimpio !== '><' && textoLimpio !== '> <') {
            marcadoresValidos.push({ marker, idCita: textoLimpio }); 
        }
    }

    const citasProcesadas = new Set(); 

    for (let i = 0; i < marcadoresValidos.length; i++) {
        const { marker: marcador, idCita } = marcadoresValidos[i];

        if (citasProcesadas.has(idCita)) continue;

        console.log(`   Procesando cita [${idCita}]...`);
        await marcador.scrollIntoViewIfNeeded();
        await marcador.hover();
        
        const tooltipLocator = page.locator('xap-dialog-layout.citation-tooltip').last();
        const tooltipTextLocator = tooltipLocator.locator('.citation-tooltip-text');
        
        try {
            await tooltipLocator.waitFor({ state: 'visible', timeout: 4000 });
        } catch (error) {
            await page.mouse.move(0, 0); 
            await page.waitForTimeout(200);
            await marcador.hover();
            await tooltipLocator.waitFor({ state: 'visible', timeout: 4000 });
        }
        
        await page.waitForTimeout(300);

        let fragmentoHTML = await tooltipTextLocator.evaluate((el) => {
            const clone = el.cloneNode(true);
            
            const limpiarHTML = (node) => {
                const walker = document.createTreeWalker(node, NodeFilter.SHOW_COMMENT, null, false);
                const comments = [];
                let cNode;
                while (cNode = walker.nextNode()) comments.push(cNode);
                comments.forEach(c => c.remove());

                // 🟢 NUEVO: Aplicamos la misma regla de <br> a los fragmentos emergentes
                const textWalker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null, false);
                const textNodes = [];
                let tNode;
                while (tNode = textWalker.nextNode()) textNodes.push(tNode);
                
                textNodes.forEach(t => {
                    if (t.nodeValue.includes('\n')) {
                        const fragment = document.createDocumentFragment();
                        const parts = t.nodeValue.split('\n');
                        parts.forEach((part, i) => {
                            if (part) fragment.appendChild(document.createTextNode(part));
                            if (i < parts.length - 1) fragment.appendChild(document.createElement('br'));
                        });
                        t.parentNode.replaceChild(fragment, t);
                    }
                });

                const badTags = ['labs-tailwind-structural-element-view-v2', 'element-list-renderer'];
                badTags.forEach(tag => {
                    node.querySelectorAll(tag).forEach(badEl => {
                        while (badEl.firstChild) badEl.parentNode.insertBefore(badEl.firstChild, badEl);
                        badEl.remove();
                    });
                });

                node.querySelectorAll('*').forEach(childEl => {
                    Array.from(childEl.attributes).forEach(attr => {
                        if (attr.name !== 'href' && attr.name !== 'src') childEl.removeAttribute(attr.name);
                    });
                });

                return node.innerHTML.trim();
            };

            return limpiarHTML(clone);
        });
        
        if (!fragmentoHTML || fragmentoHTML === '') {
            const hasImage = await tooltipTextLocator.locator('img').count() > 0;
            if (!hasImage) fragmentoHTML = "<p>[Fragmento vacío o no detectado]</p>";
        }

        const fuente = await tooltipLocator.locator('.citation-tooltip-footer').innerText();
        
        referencias.push({
            indice: parseInt(idCita, 10), 
            fuente: fuente.trim(),
            fragmento: fragmentoHTML
        });

        citasProcesadas.add(idCita);
        await page.mouse.move(0, 0);
        await tooltipLocator.waitFor({ state: 'hidden', timeout: 3000 });
    }

    const resultadoFinal = {
        pregunta: ENVIAR_NUEVA_PREGUNTA ? pregunta : "Respuesta extraída",
        respuesta_html: textoPrincipalHTML,
        citas: referencias
    };

    const jsonString = JSON.stringify(resultadoFinal, null, 2);

    const nombreArchivo = 'respuesta_notebooklm.json';
    try {
        fs.writeFileSync(nombreArchivo, jsonString, 'utf8');
        console.log(`\n💾 ¡Éxito! Archivo guardado: ${nombreArchivo}`);
    } catch (error) {
        console.error('❌ Error al guardar:', error);
    }

    await browser.close();
}

testScraping().catch(console.error);