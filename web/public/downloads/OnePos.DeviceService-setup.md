# One POS Device Service: install on a till

The Device Service lets One POS (in Chrome or Edge on this till) print receipts, open the cash drawer and drive a pole display.
Install it once on each Windows till. After that it keeps itself up to date.

1. Install the receipt printer's Windows driver and check it prints a Windows test page.
2. Plug the cash drawer into the printer's drawer port (RJ11/RJ12).
3. In One POS on the till, open **Administration › Devices** and press **Download the installer**.
4. Double-click the downloaded `OnePos.DeviceService-<version>.msi` and answer **Yes** when Windows asks for an administrator.
   The installer already knows this One POS address (it's built for this server). For many tills at once, IT can run
   `msiexec /i OnePos.DeviceService-<version>.msi /qn`.
5. Back in **Devices**, press **Check again**, choose the printer, **Save**, then **Test print** and **Open drawer**.

The service starts with Windows and restarts itself if it stops. It only listens on this PC and only accepts the One POS web
address. The One POS icon by the clock shows whether it's running and the printer's state; right-click it to print a test page
or check for updates.

Updates: the service checks this One POS server every 6 hours and installs a newer release by itself (the installer's checksum
is checked first). Switch this off per till under **Devices › Updates** to update by hand.

IT: a release is built with `tools/release-device-service.ps1 -Version <x.y.z> -WebOrigin https://<the One POS address>` on the
build PC; it puts the MSI and `latest.json` in the server's `data/releases/device-service` folder. Built without -WebOrigin,
tills must install it with `WEBORIGIN=https://<the One POS address>`.
