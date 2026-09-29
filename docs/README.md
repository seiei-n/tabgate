`tabgate.png` is rendered from `tabgate.html` (1200×675 at 2x):

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars \
  --force-device-scale-factor=2 --window-size=1200,675 --screenshot="$PWD/tabgate.png" "file://$PWD/tabgate.html"
```
