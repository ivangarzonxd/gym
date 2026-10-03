# Gym Vancho

App web (instalable en iPhone) de entrenamiento, progresión y nutrición sin lactosa.

- **Hoy**: qué día toca, calorías (Watch), peso/cintura, alcohol, hand grip.
- **D1-D5** (L, M, J, V, S): ejercicios con imagen, peso y reps calculados (doble progresión), calentamiento, temporizador de descanso y cardio.
- **Comida**: menú para ir añadiendo lo que comes, buscador de alimentos (+ Open Food Facts) y kcal manuales.
- **Método**: reglas de progresión y evolución de la fuerza (1RM estimado).
- Datos en el móvil (offline) + copia en Google Sheets.

## Publicar en GitHub Pages

1. Repo público `gym` en GitHub → push de esta carpeta.
2. Settings → Pages → Source: *Deploy from a branch* → `main` / `(root)` → Save.
3. En 1-2 min: `https://ivangarzonxd.github.io/gym/`
4. En el iPhone: abrir en Safari → Compartir → **Añadir a pantalla de inicio**.

## Conectar Google Sheets

1. Crea una hoja nueva en Google Drive (ej. "Gym Vancho").
2. Extensiones → **Apps Script** → borra lo que haya y pega `apps-script/Code.gs`.
3. Cambia `TOKEN` por una clave inventada (ej. `ivan-gym-8472`) y guarda.
4. **Implementar → Nueva implementación** → tipo *Aplicación web* → Ejecutar como: *Yo* → Acceso: *Cualquier usuario* → Implementar → autoriza con tu cuenta.
5. Copia la URL que acaba en `/exec`.
6. En la app: **Ajustes** → pega la URL y la clave → *Guardar y probar*.

Las pestañas `Series`, `Diario` y `Comidas` se crean solas.

Imágenes y guías de ejercicios: [Simply Fitness](https://www.simplyfitness.com/es/pages/workout-exercise-guides).
