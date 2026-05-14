Plik notification.mp3 to placeholder (pusty).

Pobierz prosty dźwięk powiadomienia (np. z freesound.org lub innego źródła
wolnego od opłat) i zapisz go jako:

    public/sounds/notification.mp3

Sugerowane: krótki delikatny "pop" lub "ding", maksymalnie 1 sekunda.
Format MP3, ~32–64 kbps, mono — żeby ważył jak najmniej.

Komponent app/dashboard/notifications.tsx odtwarza ten plik przy każdym
nowym powiadomieniu (realtime INSERT). Jeśli plik jest pusty/uszkodzony,
przeglądarka po prostu zignoruje błąd play() — toast i tak się pokaże.
