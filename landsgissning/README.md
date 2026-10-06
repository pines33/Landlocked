# 🌍 Landsgissning online

Ett gissningsspel för två spelare på varsin enhet. Båda väljer ett hemligt land och turas om att ställa ja/nej-frågor, muntligt i ett samtal eller i spelets chatt. Den som först gissar motspelarens land vinner.

## Kom igång lokalt

Kräver [Node.js](https://nodejs.org) 18 eller senare.

```bash
npm install
npm start
```

Öppna sedan http://localhost:3000. Vill du testa med två spelare på samma dator öppnar du den andra spelaren på http://127.0.0.1:3000 eller i ett privat fönster, så att flikarna inte delar sparad session.

För att spela med någon på samma wifi går den andra spelaren till `http://<din-dators-ip>:3000`.

## Så spelar man

1. Spelare 1 trycker **Skapa rum** och får en rumskod på fyra tecken och en delningslänk.
2. Spelare 2 öppnar länken eller skriver in koden.
3. Båda väljer sitt hemliga land på kartan eller i flagglistan.
4. Den som har turen ställer en fråga och trycker **Klar med tur** när frågan är besvarad.
5. I läget **Markera** stryker du länder: flaggan blir grå och landet rött. Tryck igen för att ångra. Markeringarna syns bara för dig.
6. I läget **Gissa** väljer du ett land och bekräftar. Rätt gissning vinner direkt och fel gissning avslutar turen.

## Teknik

| Del | Lösning |
|---|---|
| Server | Node.js, Express, `ws` (WebSocket) – `server.js` |
| Frontend | Vanlig HTML/CSS/JS i `public/`, inget byggsteg |
| Karta | jsvectormap (serveras från `node_modules`), flaggor som emoji, svenska namn via `Intl.DisplayNames` |
| Lagring | Rummen ligger i minnet och raderas efter 30 min utan aktivitet, eller 10 min efter att båda kopplat från |

**Fusksäkert:** De hemliga länderna finns bara på servern. Klienten får aldrig motspelarens land förrän omgången är slut, och det är servern som avgör om en gissning är rätt och om det är din tur.

**Återanslutning:** Varje spelare får en hemlig token som sparas i webbläsaren (`localStorage`). Om anslutningen bryts, sidan laddas om eller mobilen låses återansluter klienten automatiskt till samma plats i rummet. Chatten och dina markeringar finns kvar.

## Gratis deploy

Servern läser porten från `PORT`, vilket både Render och Railway sätter automatiskt. WebSockets fungerar på båda utan extra inställningar.

### Render

1. Lägg projektet i ett GitHub-repo.
2. Gå till [render.com](https://render.com) och välj **New → Blueprint**. Välj repot, så läses `render.yaml` in automatiskt.
   Det går också att välja **New → Web Service** och ange: Runtime *Node*, Build `npm install`, Start `npm start`, Instance type *Free*.
3. Efter någon minut får du en adress som `https://landsgissning.onrender.com`.

> Render Free går i viloläge efter cirka 15 minuter utan trafik. Första besöket efteråt tar 30–60 sekunder, och pågående rum försvinner när tjänsten somnar eftersom de bara finns i minnet.

### Railway

1. Lägg projektet i ett GitHub-repo.
2. Gå till [railway.com](https://railway.com) och välj **New Project → Deploy from GitHub repo**. Railway känner igen Node och kör `npm start`.
3. Under **Settings → Networking** klickar du **Generate Domain** för att få en publik adress.

> Railway ger en gratis provkredit och därefter en liten månadskredit. Se deras aktuella villkor.

## Filer

```
server.js          Spelserver: rum, turordning, gissningar, chatt, städning
public/index.html  Gränssnittet
public/app.js      Klientlogik: WebSocket, karta, flaggor, markeringar
public/style.css   Stil, mobil- och mörkt läge
render.yaml        Blueprint för Render
```
