using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace OnePos.DeviceTray;

/// <summary>
/// One TV: a borderless black window covering exactly that screen, showing the One POS TV page. It never takes the focus from the
/// cashier (no activation, not in Alt+Tab or the taskbar), Alt+F4 does nothing, and a crashed or failed page reloads after 5 seconds.
/// </summary>
internal sealed class TvWindow : Form
{
    private const int WsExToolWindow = 0x00000080;
    private const int WsExNoActivate = 0x08000000;

    private readonly WebView2 web;
    private readonly Task<CoreWebView2Environment> environment;
    private readonly System.Windows.Forms.Timer retry = new() { Interval = 5000 };
    private bool closing;
    private bool ready;

    /// <summary>The page shown (or about to be).</summary>
    public string? Url { get; private set; }
    /// <summary>The browser behind it ended: the controller replaces this window.</summary>
    public bool Broken { get; private set; }

    public TvWindow(Rectangle bounds, Task<CoreWebView2Environment> environment)
    {
        this.environment = environment;
        Text = "One POS TV";
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        ShowInTaskbar = false;
        TopMost = false;
        BackColor = Color.Black;
        AutoScaleMode = AutoScaleMode.None;
        target = bounds;
        Bounds = bounds;
        web = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.Black };
        Controls.Add(web);
        retry.Tick += (_, _) => { retry.Stop(); Reload(); };
    }

    protected override bool ShowWithoutActivation => true;

    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            cp.ExStyle |= WsExToolWindow | WsExNoActivate;
            return cp;
        }
    }

    protected override async void OnShown(EventArgs e)
    {
        base.OnShown(e);
        try
        {
            await web.EnsureCoreWebView2Async(await environment);
            if (IsDisposed) return;
            var s = web.CoreWebView2.Settings;
            s.AreDefaultContextMenusEnabled = false;
            s.AreDevToolsEnabled = false;
            s.IsZoomControlEnabled = false;
            s.IsPinchZoomEnabled = false;
            s.AreBrowserAcceleratorKeysEnabled = false;
            s.IsStatusBarEnabled = false;
            s.IsSwipeNavigationEnabled = false;
            s.IsGeneralAutofillEnabled = false;
            s.IsPasswordAutosaveEnabled = false;
            s.AreDefaultScriptDialogsEnabled = false;
            web.CoreWebView2.NewWindowRequested += (_, a) => a.Handled = true;   // links never open other windows
            web.CoreWebView2.NavigationCompleted += (_, a) => { if (!a.IsSuccess && a.WebErrorStatus != CoreWebView2WebErrorStatus.OperationCanceled) retry.Start(); };
            web.CoreWebView2.ProcessFailed += (_, a) =>
            {
                if (a.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited) Broken = true;
                else retry.Start();
            };
            ready = true;
            if (Url is not null) web.CoreWebView2.Navigate(Url);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            Broken = true;   // the controller makes a new window
        }
    }

    public void Navigate(string url)
    {
        Url = url;
        if (!ready) return;
        try { web.CoreWebView2.Navigate(url); }
        catch (Exception ex) when (ex is not OutOfMemoryException) { retry.Start(); }
    }

    private void Reload()
    {
        if (!ready || Url is null || IsDisposed) return;
        try { web.CoreWebView2.Navigate(Url); }
        catch (Exception ex) when (ex is not OutOfMemoryException) { Broken = true; }
    }

    private Rectangle target;

    /// <summary>
    /// Keeps the window exactly on its screen (in the screen's own pixels). Checked against where Windows really has it, since a
    /// change of resolution or display scaling can move or resize it behind WinForms' back.
    /// </summary>
    public void Place(Rectangle bounds)
    {
        target = bounds;
        if (!IsHandleCreated) { Bounds = bounds; return; }
        if (GetWindowRect(Handle, out var r) && r.Left == bounds.Left && r.Top == bounds.Top && r.Right == bounds.Right && r.Bottom == bounds.Bottom) return;
        SetWindowPos(Handle, IntPtr.Zero, bounds.X, bounds.Y, bounds.Width, bounds.Height, SwpNoZOrder | SwpNoActivate);
    }

    /// <summary>A screen whose display scaling changes sends WM_DPICHANGED with a suggested size: ignored, the window stays on its screen.</summary>
    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WmDpiChanged)
        {
            m.Result = IntPtr.Zero;
            BeginInvoke(() => { if (!IsDisposed) Place(target); });
            return;
        }
        base.WndProc(ref m);
    }

    private const int WmDpiChanged = 0x02E0;
    private const uint SwpNoZOrder = 0x0004, SwpNoActivate = 0x0010;

    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    private struct Rect { public int Left, Top, Right, Bottom; }

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out Rect rect);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);

    /// <summary>Only the controller closes a TV window.</summary>
    public void CloseTv()
    {
        closing = true;
        retry.Stop();
        Close();
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        // Alt+F4 and the like do nothing; Windows shutting down or the app ending still close it.
        if (!closing && e.CloseReason is CloseReason.UserClosing or CloseReason.None) e.Cancel = true;
        base.OnFormClosing(e);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) { retry.Dispose(); web.Dispose(); }
        base.Dispose(disposing);
    }
}
