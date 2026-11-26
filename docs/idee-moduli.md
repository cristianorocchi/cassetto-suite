# Idee per nuovi moduli di Cassetto

Oggi Cassetto ha due moduli:

- **Plastico** (il mondo): le scene, le vie tra le scene, i piani, le persone, i momenti della
  giornata, gli atti e le aree.
- **Puzzle Charts** (gli enigmi): i passi, i sotto-obiettivi, gli oggetti, le combinazioni e le fasi.

Un gioco narrativo punta e clicca però ha altro da progettare oltre a "dove" e "cosa sblocca cosa":
**chi dice cosa**, **con quali oggetti**, **che cosa ricorda il gioco**, **cosa vede il giocatore
in ogni stanza**.

Ogni idea qui sotto segue le regole dei moduli che ci sono già:

- possiede una cartella del progetto;
- risponde alla propria API e ha la propria pagina;
- offre **interfacce** con un nome agli altri moduli e usa quelle degli altri con
  `ctx.require` / `ctx.optional`;
- funziona anche se un altro modulo manca.

Per ogni idea indico:

- che cosa contiene;
- la cartella che possiede;
- che cosa offre e che cosa usa;
- che cosa può fare con Godot;
- la priorità e lo sforzo, secondo me.

---

## Sommario

| # | Modulo | In una riga | Priorità | Sforzo |
|---|---|---|---|---|
| 1 | **Oggetti** | Il catalogo degli oggetti: dove si trovano, con cosa si combinano, che testi hanno | Alta | Medio |
| 2 | **Dialoghi** | Gli alberi di dialogo dei personaggi, con condizioni ed effetti | Alta | Alto |
| 3 | **Stato del gioco** | Il registro di flag e variabili: chi le scrive, chi le legge, quali non servono | Alta | Basso |
| 4 | **Stanze / Hotspot** | Che cosa si può guardare, usare e prendere in ogni scena, e la risposta a ogni verbo | Alta | Medio |
| 5 | **Percorso** | Una soluzione completa del gioco, calcolata, con vicoli ciechi e scorciatoie | Media | Medio |
| 6 | **Personaggi** | La bibbia del cast: chi sono, cosa vogliono, dove sono in ogni momento | Media | Basso |
| 7 | **Trama** | La scaletta della storia: atti, capitoli, momenti, legati a scene ed enigmi | Media | Medio |
| 8 | **Suggerimenti** | Gli aiuti a gradi per ogni enigma, scritti partendo dai grafici | Media | Basso |
| 9 | **Testi e lingue** | Tutte le stringhe del gioco in un posto, con le traduzioni | Media | Medio |
| 10 | **Cantiere** | Gli asset da produrre (sfondi, animazioni, suoni, voci) e a che punto sono | Media | Medio |
| 11 | **Sequenze** | Le scene animate e gli eventi scriptati, su una linea del tempo | Bassa | Alto |
| 12 | **Suono** | Musiche, ambienti ed effetti per scena, area, atto e momento della giornata | Bassa | Basso |
| 13 | **Taccuino** | Note libere attaccate a qualsiasi cosa del progetto | Bassa | Basso |
| 14 | **Playtest** | Le sessioni dei tester: dove si sono bloccati, mostrato sui grafici | Bassa | Medio |
| 15 | **Documento di design** | Il GDD generato dal progetto, da esportare o condividere | Bassa | Basso |

Le idee con priorità **Alta** riempiono i buchi che si vedono già oggi:

- i passi "oggetto" e "combinazione" di Puzzle Charts non hanno ancora un catalogo dietro;
- le persone di Plastico non parlano;
- i game id dei passi non hanno un registro.

In `integrations/godot.py` ci sono già due capacità solo preparate: *controllare i game id* e
*costruire i passi nel gioco*. Il modulo 3 (Stato del gioco) e il modulo 1 (Oggetti) sono il
posto naturale dove realizzarle.

---

## 1. Oggetti (inventario)

**Che cosa contiene.** Ogni oggetto del gioco:

- il nome, l'id di gioco e l'icona;
- la descrizione quando lo si guarda;
- dove si trova all'inizio (una scena, una persona, un altro oggetto);
- quando sparisce (consumato, trasformato, restituito).

Ha anche una **matrice delle combinazioni**: oggetto × oggetto e oggetto × hotspot. Ogni cella dice
che cosa succede, oppure è vuota.

**Perché serve.** Oggi in Puzzle Charts un passo "oggetto" o "combinazione" è un nodo con un titolo.
Con questo modulo il passo punta a un oggetto vero, e si possono controllare cose come:

- un oggetto che si raccoglie due volte;
- un oggetto usato prima di averlo preso;
- un oggetto che resta nell'inventario fino alla fine senza servire;
- una combinazione che non è in nessun grafico.

**Dati.** `items/items.json` (il catalogo) e `items/icons/`.

**Offre:**

- `items.catalog`: gli oggetti con id, nome e luogo, per i selettori di Puzzle Charts e di Plastico;
- `items.lifetime`: per ogni oggetto, da quale passo a quale passo il giocatore lo tiene in mano,
  calcolato dai grafici.

**Usa:**

- `world.catalog`, per i luoghi di partenza;
- `puzzles.charts`, per sapere in quali passi entra ogni oggetto.

**Con Godot:**

- confrontare gli id con le risorse degli oggetti del gioco;
- generare le risorse mancanti (un `.tres` per oggetto) con backup e Annulla, come fa il Build di
  Plastico.

**Idee per la pagina:**

- una griglia di schede;
- la matrice delle combinazioni a colori: piena, vuota, "solo una risposta di rifiuto";
- una linea del tempo che mostra quanti oggetti ha in tasca il giocatore in ogni atto.

---

## 2. Dialoghi

**Che cosa contiene.** Per ogni personaggio, i dialoghi come grafici di battute e scelte. Ogni nodo
può avere:

- **condizioni**: un flag, un oggetto in mano, l'atto, il momento della giornata;
- **effetti**: imposta un flag, dà o toglie un oggetto, sblocca un passo.

**Perché serve.** Nei giochi punta e clicca molti passi degli enigmi sono "parla con X e chiedi di
Y". Oggi la conversazione vive fuori dal progetto. Con questo modulo:

- un passo di Puzzle Charts può puntare alla battuta esatta che lo compie;
- da un personaggio in Plastico si apre il suo dialogo;
- si vede quali argomenti diventano disponibili dopo quali passi.

**Dati:** `dialogue/<persona>.json`, oppure un file per conversazione.

**Offre:**

- `dialogue.lines`, per cercare, contare e localizzare le battute;
- `dialogue.effects`, cioè chi imposta quali flag e chi dà quali oggetti, per il modulo 3 e il
  modulo 5.

**Usa:**

- `world.catalog`, per le persone e dove si trovano;
- `items.catalog`;
- `state.flags`.

**Con Godot:** esportare in un formato che il gioco legge già. Si sceglie una volta per progetto:
Dialogue Manager, Dialogic, ink o Yarn Spinner. L'importazione inversa permette di riprendere in
Cassetto i dialoghi già scritti.

**Idee per la pagina:**

- un grafico simile a Puzzle Charts (riusa il motore di layout ELK/dagre);
- una vista "copione" lineare per leggere e correggere i testi;
- un'anteprima che "recita" il dialogo con uno stato di gioco finto.

---

## 3. Stato del gioco (flag e variabili)

**Che cosa contiene.** Il registro di tutto ciò che il gioco ricorda: flag booleani, contatori,
stati di una scena ("porta aperta", "lampada accesa"). Per ognuno indica:

- il tipo e il valore iniziale;
- una descrizione;
- **chi lo scrive** e **chi lo legge**.

**Perché serve.** È il collante dei moduli. Dai grafici, dai dialoghi e dagli hotspot ricava i
controlli:

- un flag letto ma mai scritto: l'enigma non si risolve mai;
- un flag scritto ma mai letto: lavoro inutile;
- due nomi quasi uguali (`door_open` e `dor_open`).

Il modulo ha uno sforzo basso: all'inizio è quasi tutto calcolato dagli altri moduli.

**Dati:** `state/flags.json`, solo con le descrizioni e i valori iniziali. Chi scrive e chi legge si
calcola sempre, non si salva.

**Offre:**

- `state.flags`;
- `state.references`, con gli stessi avvisi di `puzzles.references`, da mostrare nel contatore dei
  collegamenti rotti della shell.

**Usa:** `puzzles.charts` (i game id dei passi), `dialogue.effects`, `hotspots.effects`, e solo
quelli che ci sono.

**Con Godot:**

- leggere i flag e le variabili del gioco (un autoload, un `GameState.gd`) e confrontarli;
- generare l'enum o il dizionario dei flag.

È la capacità "controllare i game id" già prevista in `CAPABILITIES`.

---

## 4. Stanze / Hotspot

**Che cosa contiene.** Per ogni scena di Plastico, gli **hotspot**: le cose che il giocatore può
indicare col mouse. Per ognuno:

- il nome;
- dove sta sullo sfondo (un rettangolo o un poligono disegnato sopra l'arte della scena);
- la **risposta a ogni verbo**: guarda, usa, prendi, parla, e "usa oggetto su";
- le uscite verso le altre scene.

**Perché serve.** È il cuore di un punta e clicca, e oggi manca. Plastico sa che "la cucina porta al
corridoio", ma non *dove* si clicca per andarci né *cosa dice* il protagonista guardando il
frigorifero. Si possono controllare cose come:

- gli hotspot senza una risposta a "guarda";
- un "usa X su Y" previsto da un grafico, ma senza risposta;
- un hotspot che porta a un'uscita che non esiste in Plastico.

**Dati:** `hotspots/<scena>.json`.

**Offre:**

- `hotspots.list`, cioè gli hotspot per scena, per i selettori di Puzzle Charts ("questo passo si
  fa sull'hotspot frigorifero");
- `hotspots.effects`.

**Usa:**

- `world.catalog`, per le scene, le uscite e l'arte per momento della giornata, che Plastico sa
  già leggere;
- `items.catalog`.

**Con Godot:** il Build di Plastico costruisce già le scene. Questo modulo aggiungerebbe le `Area2D`
degli hotspot con le loro forme, e i testi delle risposte.

**Idee per la pagina:**

- lo sfondo della scena con le forme disegnate sopra;
- accanto, una tabella verbo × hotspot da riempire, con le celle vuote evidenziate.

---

## 5. Percorso (soluzione e analisi)

**Che cosa contiene.** Non ha quasi dati suoi: **calcola** una soluzione completa del gioco
partendo dai grafici (l'ordine dei passi), dal mondo (le strade e gli spostamenti), dagli oggetti e
dai flag. Poi la mostra come una lista di passi giocabili.

**Perché serve.** La modalità "Play test" di Plastico calcola già fin dove si arriva con certe
chiavi. Questo modulo la allarga a tutto il gioco e trova:

- **vicoli ciechi**: uno stato da cui non si arriva più alla fine (un oggetto consumato troppo
  presto);
- **scorciatoie**: un passo che si può fare prima del previsto;
- **colli di bottiglia**: un momento in cui c'è una sola cosa da fare;
- **troppa libertà**: un momento in cui ci sono 15 cose aperte insieme;
- quanta strada si fa avanti e indietro tra le scene.

**Dati:** `walkthrough/` con le soluzioni salvate e le note. Tutto il resto si calcola.

**Offre:**

- `walkthrough.order`, cioè l'ordine dei passi, usato dal modulo 8 e dal modulo 15;
- `walkthrough.issues`.

**Usa:** `puzzles.charts`, `world.catalog`, e quando ci sono `items.lifetime` e `state.flags`.

**Idee per la pagina:**

- la soluzione come lista numerata, con la scena di ogni passo;
- un grafico della "larghezza" del gioco nel tempo, cioè quanti passi sono aperti insieme;
- un clic su un problema apre il passo in Puzzle Charts.

---

## 6. Personaggi

**Che cosa contiene.** La scheda di ogni persona del mondo: chi è, cosa vuole, come parla, il ritratto
e le relazioni con gli altri (un piccolo grafico). Ha anche l'**agenda**: dove si trova in ogni atto
e in ogni momento della giornata.

**Perché serve.** Plastico conosce già le persone e sa dove si trovano, ma solo come dati del mondo.
Questo modulo ne fa una bibbia del cast. Così i dialoghi (modulo 2) hanno un tono di voce da
rispettare, e chi scrive sa sempre chi è chi.

**Dati:** `cast/<persona>.json` e `cast/portraits/`.

**Offre:** `cast.people`, cioè le schede, per i dialoghi e per il documento di design.

**Usa:** `world.catalog` per le persone. Le persone restano di Plastico: questo modulo aggiunge
soltanto. Se una persona cambia id, si sposta la scheda, come fa `puzzles.rename_scene` per i passi.

---

## 7. Trama

**Che cosa contiene.** La scaletta della storia:

- atti, capitoli e momenti narrativi (*beat*);
- per ogni momento: che cosa succede, che cosa impara il giocatore, l'emozione cercata;
- il **collegamento** a scene, obiettivi dei grafici e dialoghi.

**Perché serve.** Oggi gli atti stanno in Plastico come filtri. La trama dà loro un contenuto, e si
possono controllare cose come:

- un momento chiave che non ha un enigma che ci porti;
- un enigma lungo che non porta avanti la storia;
- un atto molto più lungo degli altri.

**Dati:** `story/outline.json`.

**Offre:** `story.beats`.

**Usa:**

- `world.catalog`, per gli atti e le scene;
- `puzzles.charts`, per gli obiettivi;
- `walkthrough.order`, per vedere i momenti nell'ordine in cui il giocatore li vive.

**Idee per la pagina:** una lavagna di cartoncini, una colonna per atto, con la "curva" dell'intensità
sopra.

---

## 8. Suggerimenti

**Che cosa contiene.** Per ogni passo o sotto-obiettivo, gli aiuti a gradi: da "pensa alla cucina" a
"usa il coltello sul nastro adesivo".

**Perché serve.** Gli aiuti sono quasi obbligatori nei giochi di oggi, e i grafici delle dipendenze
dicono già **che cosa** il giocatore deve capire e **in che ordine**. Il modulo:

- propone le bozze dei gradi partendo dal grafico;
- controlla che ogni passo non ovvio abbia un aiuto;
- dato uno stato del gioco, dice quale aiuto mostrare: i passi aperti con un grado più alto per
  quelli fermi da più tempo.

**Dati:** `hints/<grafico>.json`.

**Offre:** `hints.for_state`, cioè gli aiuti da mostrare dato un insieme di passi fatti, da
esportare nel gioco.

**Usa:** `puzzles.charts` e `walkthrough.order`.

**Con Godot:** esportare una tabella di aiuti per id di passo, che il gioco interroga.

---

## 9. Testi e lingue

**Che cosa contiene.** Tutte le stringhe del gioco in una tabella sola:

- i nomi delle scene, degli oggetti e degli hotspot;
- le risposte ai verbi;
- le battute dei dialoghi.

Per ogni stringa ci sono le traduzioni, lo stato (da fare, tradotta, rivista) e le note per chi
traduce.

**Perché serve.** I testi nascono sparsi in quattro moduli. Questo modulo li raccoglie senza esserne
il proprietario: ogni testo resta del modulo che lo scrive, e il modulo Testi ci aggiunge sopra le
traduzioni. Si possono controllare cose come:

- le stringhe mancanti in una lingua;
- le stringhe troppo lunghe per il fumetto o per il pulsante;
- i segnaposto (`{nome}`) che non corrispondono tra le lingue;
- le stringhe cambiate dopo la traduzione.

**Dati:** `text/<lingua>.json`.

**Offre:** `text.translate`.

**Usa:** ogni modulo che offre stringhe, attraverso una convenzione di interfaccia: `<modulo>.strings`.

**Con Godot:** esportare in CSV o PO, i formati che legge il sistema di traduzione di Godot.

---

## 10. Cantiere (produzione)

**Che cosa contiene.** L'elenco di ciò che serve **produrre**, ricavato in buona parte dagli altri
moduli:

- uno sfondo per ogni scena e per ogni momento della giornata;
- un'icona per ogni oggetto;
- un ritratto per ogni persona;
- una voce per ogni battuta;
- un brano per ogni ambiente.

Per ogni asset indica lo stato (da fare, bozza, finale), chi ci lavora e il file.

**Perché serve.** Trasforma il progetto in un piano di lavoro. Plastico sa già leggere l'arte per
momento della giornata dal gioco Godot, quindi per gli sfondi lo stato si può *vedere* e non serve
segnarlo a mano.

**Dati:** `production/tasks.json`, cioè gli stati e le persone. Gli asset si calcolano.

**Usa:**

- `world.catalog`;
- quando ci sono, `items.catalog`, `cast.people`, `dialogue.lines` e `sound.cues`.

**Idee per la pagina:**

- una tabella filtrabile;
- una barra di avanzamento per atto;
- l'export in CSV per chi usa un altro strumento.

---

## 11. Sequenze (scene animate ed eventi)

**Che cosa contiene.** Le scene non giocabili (intro, finale, i passaggi tra un atto e l'altro) e gli
eventi scriptati. Ogni sequenza ha:

- un innesco: un passo compiuto, l'ingresso in una scena;
- una **linea del tempo** di azioni: un personaggio cammina, dice, la camera si sposta, si
  imposta un flag.

**Perché serve.** Molti obiettivi dei grafici finiscono con "e poi succede questo". Oggi quel
"questo" non è da nessuna parte.

**Dati:** `sequences/<id>.json`.

**Usa:** `world.catalog`, `puzzles.charts`, `dialogue.lines` e `state.flags`.

**Con Godot:** esportare in `AnimationPlayer` o in uno script di eventi. È la parte più costosa e
quella che dipende di più da come è fatto il gioco, quindi conviene farla per ultima.

---

## 12. Suono

**Che cosa contiene.** I *cue* audio:

- la musica per area, atto o momento della giornata;
- l'ambiente di ogni scena;
- gli effetti legati agli hotspot e ai passi (il "clic" della serratura che si apre).

**Perché serve.** Le aree e i momenti della giornata esistono già in Plastico: il modulo li usa
come chiavi. Una vista colorata del mondo mostra le zone senza musica e i passaggi bruschi tra un
brano e l'altro.

**Dati:** `sound/cues.json`.

**Offre:** `sound.cues`.

**Usa:** `world.catalog` e `hotspots.list`.

---

## 13. Taccuino

**Che cosa contiene.** Note libere in Markdown, attaccate a qualsiasi cosa del progetto (una scena,
un passo, una persona, un oggetto) oppure a niente. Ci sono anche i TODO con lo stato.

**Perché serve.** Le idee nascono mentre si lavora, e oggi finiscono fuori dal progetto. Un modulo
minuscolo:

- un'icona "nota" in ogni pannello;
- un elenco di tutte le note;
- i file Markdown leggibili e modificabili anche da un editor, da git o da Claude, come gli altri
  dati del progetto.

**Dati:** `notes/<id>.md`, con un piccolo frontmatter che dice a che cosa è attaccata la nota.

**Offre:** `notes.for`, cioè le note di un oggetto, per mostrarle nei pannelli degli altri moduli.

---

## 14. Playtest

**Che cosa contiene.** Le sessioni dei tester:

- importate da un log che il gioco Godot scrive (passi compiuti, con l'orario);
- oppure inserite a mano.

**Perché serve.** Mette i dati veri sopra il progetto:

- una **mappa di calore** sui grafici, cioè dove i giocatori restano bloccati più a lungo;
- in Plastico, quali scene visitano di più;
- il confronto tra l'ordine previsto (modulo 5) e quello reale.

**Dati:** `playtests/<sessione>.json`.

**Usa:** `puzzles.charts`, `world.catalog` e `walkthrough.order`.

**Con Godot:** un piccolo script da mettere nel gioco che scrive il log nel formato giusto.

---

## 15. Documento di design

**Che cosa contiene.** Non ha dati suoi: genera il documento di design del gioco (GDD) da tutto il
progetto:

- la trama;
- i personaggi;
- il mondo (con l'immagine del modello 3D di Plastico);
- gli enigmi con i loro grafici;
- gli oggetti;
- la soluzione.

**Perché serve.** Per mandare il progetto a chi non usa Cassetto: un editore, un collaboratore, un
bando. Si sceglie che cosa includere e si esporta in HTML, PDF o Markdown.

**Usa:** tutte le interfacce che trova, con `ctx.optional`. Se un modulo manca, salta la sua sezione.

---

## Un ordine possibile

1. **Stato del gioco** (3): è poco lavoro, dà subito controlli utili, e su di esso si appoggiano
   oggetti, dialoghi e hotspot. Realizza la capacità Godot che è già prevista.
2. **Oggetti** (1): dà un significato ai passi "oggetto" e "combinazione" che ci sono già.
3. **Stanze / Hotspot** (4): chiude il cerchio tra mondo, oggetti ed enigmi, ed è il punto dove il
   progetto diventa davvero "punta e clicca".
4. **Dialoghi** (2): il modulo più grande, ma con i tre di prima ha già tutto ciò che gli serve per
   condizioni ed effetti.
5. **Percorso** (5): con tutti questi dati, l'analisi della soluzione diventa precisa.
6. Il resto in base al bisogno: Personaggi e Trama per chi scrive, Testi e Cantiere per chi produce,
   Suggerimenti e Playtest per chi rifinisce.

## Cose da decidere prima di cominciare

- **Chi possiede le persone.** Oggi sono di Plastico. Con il modulo Personaggi conviene lasciarle a
  Plastico, che decide dove sono, e far *aggiungere* le schede al nuovo modulo, sullo stesso schema
  di `puzzles.rename_scene`.
- **Le stringhe.** Ogni modulo tiene i propri testi. Una convenzione `<modulo>.strings` permette al
  modulo Testi di raccoglierli senza importare niente dagli altri.
- **I game id.** Un unico spazio di nomi (`item.coltello`, `flag.porta_aperta`, `hotspot.cucina.frigo`)
  evita le collisioni tra moduli e rende facile il confronto con Godot.
- **L'ordine nella barra.** Con 5 o più schede, la barra della shell potrebbe raggrupparle:
  *Mondo* (Plastico, Stanze, Suono), *Storia* (Trama, Personaggi, Dialoghi), *Logica* (Enigmi,
  Oggetti, Stato, Percorso), *Produzione* (Cantiere, Testi, Playtest).
