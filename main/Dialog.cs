using System.Runtime.ExceptionServices;
using DialogResult = NativeFileDialogSharp.DialogResult;

namespace VRCNext;

/// <summary>
/// Stands in for <see cref="NativeFileDialogSharp.Dialog"/> in all VRCNext code: it has the same name, so a plain
/// <c>Dialog.FileOpen(...)</c> lands here. On Linux the page's messages are handled off GTK's main thread (see
/// AppShell.EnqueueWebMessage), but GTK file dialogs must open on that thread, so each call is moved there and
/// waited for. On Windows, or before the window exists, it calls straight through.
/// </summary>
internal static class Dialog
{
    /// <summary>Runs an action on the window's UI thread and waits for it. Set by AppShell on Linux only.</summary>
    internal static Action<Action>? RunOnUiThread;

    public static DialogResult FileOpen(string? filterList = null, string? defaultPath = null) =>
        Run(() => NativeFileDialogSharp.Dialog.FileOpen(filterList, defaultPath));

    public static DialogResult FileOpenMultiple(string? filterList = null, string? defaultPath = null) =>
        Run(() => NativeFileDialogSharp.Dialog.FileOpenMultiple(filterList, defaultPath));

    public static DialogResult FileSave(string? filterList = null, string? defaultPath = null) =>
        Run(() => NativeFileDialogSharp.Dialog.FileSave(filterList, defaultPath));

    public static DialogResult FolderPicker(string? defaultPath = null) =>
        Run(() => NativeFileDialogSharp.Dialog.FolderPicker(defaultPath));

    private static DialogResult Run(Func<DialogResult> open)
    {
        var runOnUiThread = RunOnUiThread;
        if (runOnUiThread == null) return open();

        DialogResult? result = null;
        ExceptionDispatchInfo? error = null;
        // An exception must not cross the native UI-thread callback, so it is caught there and thrown again here.
        runOnUiThread(() =>
        {
            try { result = open(); }
            catch (Exception ex) { error = ExceptionDispatchInfo.Capture(ex); }
        });
        error?.Throw();
        return result!;
    }
}
