# Umzugskiste

Zieht Playlists von einem Musikdienst zum anderen um. Offline-first PWA ohne Server, ohne Konto, ohne Build-Schritt.

## Was geht

| | Einlesen | Eintragen |
|---|---|---|
| Spotify | Playlists, Lieblingssongs | Playlists, Lieblingssongs |
| YouTube / YouTube Music | Playlists | Playlists (rund 100 Songs am Tag) |
| Deezer | öffentliche Playlists und Alben per Link | Klickliste |
| Apple Music, TIDAL, Amazon, SoundCloud, Beatport, Bandcamp | über Datei | Klickliste |
| Text, CSV, TXT, JSON, M3U | ja | Export als CSV, TXT, JSON |

- **Abgleich:** erst ISRC, dann Titel, Künstler und Länge. Andere Versionen (Extended Mix und Radio Edit) gelten als unsicher und landen zur Prüfung bei dir.
- **Teilen:** Die Kiste steckt gepackt im `#`-Teil des Links. Kein Server sieht sie.
- **Nachziehen:** Holt neue Songs in die Ziel-Playlist. Das passiert von Hand, ein Hintergrund-Sync bräuchte einen Server.
- **Offline:** Kisten packen, ansehen, exportieren und teilen geht ohne Netz. Umzüge warten und laufen online weiter, an genau der Stelle. Das gilt auch nach Schließen der App, nach Ablauf der Anmeldung und nach dem YouTube-Tageslimit, solange die App dann offen ist.

## Dienste einrichten

Jeder braucht eigene Zugangs-IDs, Schritte stehen in der App unter „Dienste“.

- **Spotify:** App im Developer Dashboard anlegen, Premium nötig. Dev-Mode erlaubt fünf Nutzer pro Client ID, darum bringt jeder seine eigene mit.
- **YouTube:** OAuth-Client in der Google Cloud Console. Redirect URI ist die Adresse der Seite.

Lokal muss die Adresse `http://127.0.0.1:5173/` sein, Spotify lehnt `localhost` ab.

## Entwicklung

```sh
npm start        # http://127.0.0.1:5173/
npm test         # Logik: Parser, Abgleich, Umzug, Teilen
npm run e2e      # Browser-Test mit nachgebauten Dienst-APIs, Screenshots in e2e/shots/
```

`e2e` braucht ein global installiertes Playwright. Die App selbst hat keine Abhängigkeiten.

Aufbau: `src/transfer.js` steuert den Umzug, `src/match.js` den Abgleich, `src/services/` die Dienste. Ein neuer Dienst ist ein Adapter mit `search`, `createPlaylist`, `existingIds` und `addTracks` und ein Eintrag in `src/services/index.js`.

## Release

Version in `src/model.js`, `package.json` und `CACHE` in `sw.js` erhöhen. Neue Dateien in `SHELL` in `sw.js` eintragen, `npm test` prüft beides.

## Rechtliches

Spotify Developer Policy III.9 verbietet Übertragungen an andere Dienste, nimmt aber Playlist-Metadaten der Nutzer und deren eigene Daten aus. Die App überträgt nur das. Der Name darf nicht an Spotify erinnern (VI.2).

Nicht verbunden mit Spotify, Google, Apple, Deezer oder TIDAL und nicht von ihnen unterstützt. Schriften: SIL OFL, siehe `fonts/LICENSE.txt`.
