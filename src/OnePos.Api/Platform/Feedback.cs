using System.Reflection;
using System.Security.Cryptography;
using Dapper;
using Npgsql;
using OnePos.Api.Data;

namespace OnePos.Api.Platform;

/// <summary>
/// "Report a problem" (as AWS One's Platform/Feedback.cs; migration 0021): the in-app issue channel. Any signed-in user (a till too)
/// reports from any screen; the report carries by itself the screen, the company, branch and till, the user, the browser and screen
/// size, the app version and the errors the browser met in the last two hours, plus an optional screenshot (taken in the browser)
/// and files. Administrators work the list (Administration › Problem reports): status New → In progress → Fixed / Won't fix,
/// assignee, priority, comments; changes go to the platform audit trail. The reporter sees and comments on their own reports.
/// Nothing leaves the system (no outside service).
/// </summary>
public static class Feedback
{
    public static readonly string[] Statuses = ["new", "in_progress", "fixed", "wont_fix"];
    public static readonly string[] Kinds = ["problem", "question", "idea"];
    public static readonly string[] Severities = ["blocker", "major", "normal", "minor"];
    private const long MaxFileBytes = 10 * 1024 * 1024;

    private static readonly string? AppVersion = typeof(Feedback).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;

    public sealed record ReportInput(string Title, string Description, string? Kind = null, string? Severity = null, string? Steps = null,
        string? PagePath = null, string? PageTitle = null, string? Browser = null, string? Screen = null, string[]? Errors = null);

    public sealed record UpdateInput(string Status, Guid? AssigneeId, string Severity, string? Resolution);

    public sealed record CommentInput(string Body);

    public sealed class Row
    {
        public Guid Id { get; set; }
        public string Number { get; set; } = "";
        public Guid UserId { get; set; }
        public string? UserName { get; set; }
        public Guid? CompanyId { get; set; }
        public string? CompanyCode { get; set; }
        public string? CompanyName { get; set; }
        public Guid? BranchId { get; set; }
        public string? BranchCode { get; set; }
        public string? BranchName { get; set; }
        public string? RegisterName { get; set; }
        public string Kind { get; set; } = "";
        public string Severity { get; set; } = "";
        public string Title { get; set; } = "";
        public string Description { get; set; } = "";
        public string? Steps { get; set; }
        public string? PagePath { get; set; }
        public string? PageTitle { get; set; }
        public string? Browser { get; set; }
        public string? Screen { get; set; }
        public string? AppVersion { get; set; }
        public string[] ClientErrors { get; set; } = [];
        public string Status { get; set; } = "";
        public Guid? AssigneeId { get; set; }
        public string? AssigneeName { get; set; }
        public string? Resolution { get; set; }
        public DateTime CreatedAt { get; set; }
        public DateTime UpdatedAt { get; set; }
        public DateTime? ClosedAt { get; set; }
        public int Comments { get; set; }
        public int Files { get; set; }
        public bool HasScreenshot { get; set; }
    }

    public sealed class Comment
    {
        public long Id { get; set; }
        public Guid UserId { get; set; }
        public string? UserName { get; set; }
        public bool IsAdmin { get; set; }
        public string Body { get; set; } = "";
        public DateTime CreatedAt { get; set; }
    }

    public sealed class FileRow
    {
        public Guid Id { get; set; }
        public string Kind { get; set; } = "";
        public string FileName { get; set; } = "";
        public string ContentType { get; set; } = "";
        public long SizeBytes { get; set; }
        public string? UploadedBy { get; set; }
        public DateTime UploadedAt { get; set; }
    }

    private const string Select = """
        select f.*, u.display_name as user_name, a.display_name as assignee_name,
               (select count(*) from feedback_comment c where c.feedback_id = f.id)::int as comments,
               (select count(*) from feedback_file x where x.feedback_id = f.id)::int as files,
               exists (select 1 from feedback_file x where x.feedback_id = f.id and x.kind = 'screenshot') as has_screenshot
        from feedback f join app_user u on u.id = f.user_id left join app_user a on a.id = f.assignee_id
        """;

    public static string StatusLabel(string s) => s switch { "new" => "New", "in_progress" => "In progress", "fixed" => "Fixed", "wont_fix" => "Won't fix", _ => s };
    private static string SeverityLabel(string s) => s switch { "blocker" => "Blocker", "major" => "Major", "normal" => "Normal", "minor" => "Minor", _ => s };
    private static string KindLabel(string s) => s switch { "problem" => "Problem", "question" => "Question", "idea" => "Idea", _ => s };

    /// <summary>The file types a report takes, by extension; images and PDFs are also checked by their first bytes.</summary>
    private static readonly Dictionary<string, string> Types = new(StringComparer.OrdinalIgnoreCase)
    {
        [".png"] = "image/png", [".jpg"] = "image/jpeg", [".jpeg"] = "image/jpeg", [".webp"] = "image/webp", [".pdf"] = "application/pdf",
        [".txt"] = "text/plain", [".log"] = "text/plain", [".csv"] = "text/csv",
        [".xlsx"] = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", [".docx"] = "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    };

    /// <summary>Shown in the browser (the screenshot, photos, PDFs); everything else downloads.</summary>
    private static readonly HashSet<string> Inline = ["image/png", "image/jpeg", "image/webp", "application/pdf"];

    public static void Map(RouteGroupBuilder api, IConfiguration config, IWebHostEnvironment env)
    {
        var root = Path.GetFullPath(config["Images:Root"] ?? Path.Combine(env.ContentRootPath, "..", "..", "data", "images"));

        api.MapPost("/feedback", async (HttpContext http, Db db, ReportInput body) =>
        {
            var me = http.CurrentUser();
            var title = (body.Title ?? "").Trim();
            var description = (body.Description ?? "").Trim();
            if (title.Length < 3) throw new DomainException("Give the problem a short title (at least 3 characters).");
            if (title.Length > 200) throw new DomainException("The title can be at most 200 characters.");
            if (description.Length == 0) throw new DomainException("Describe what happened (and what you expected).");
            if (description.Length > 8000 || (body.Steps?.Length ?? 0) > 8000) throw new DomainException("The description can be at most 8,000 characters.");
            var kind = body.Kind ?? "problem";
            var severity = body.Severity ?? "normal";
            if (!Kinds.Contains(kind)) throw new DomainException("Choose problem, question or idea.");
            if (!Severities.Contains(severity)) throw new DomainException("Choose the priority: blocker, major, normal or minor.");
            // The company and branch of the screen (optional: a user without a company has none); only ones the user may open.
            Scope? scope = null;
            if (me.TillCompanyId is not null || Guid.TryParse(http.Request.Headers[RequestContext.CompanyHeader].ToString(), out _))
                try { scope = await http.ScopeAsync(db); } catch (DomainException) { }
            var register = scope?.RegisterId is { } rid
                ? await db.Company(scope.CompanyId, (c, tx) => c.ExecuteScalarAsync<string?>("select name from register where id = @rid", new { rid }, tx)) : null;
            var errors = (body.Errors ?? []).Where(e => !string.IsNullOrWhiteSpace(e)).Take(10).Select(e => Cut(e.Trim(), 500)!).ToArray();
            var id = Guid.NewGuid();
            var number = await db.Platform(async (c, tx) =>
            {
                var co = scope is null ? default
                    : await c.QuerySingleOrDefaultAsync<(string Code, string Name)>("select code, name from company where id = @id", new { id = scope.CompanyId }, tx);
                var br = scope?.BranchId is { } bid
                    ? await c.QuerySingleOrDefaultAsync<(string Code, string Name)>("select code, name from branch where id = @bid", new { bid }, tx) : default;
                var number = $"FB-{await c.ExecuteScalarAsync<long>("select nextval('feedback_number_seq')", transaction: tx):000000}";
                await c.ExecuteAsync("""
                    insert into feedback (id, number, user_id, company_id, company_code, company_name, branch_id, branch_code, branch_name, register_name,
                                          kind, severity, title, description, steps, page_path, page_title, browser, screen, app_version, client_errors)
                    values (@id, @number, @user, @companyId, @coCode, @coName, @branchId, @brCode, @brName, @register,
                            @kind, @severity, @title, @description, @steps, @pagePath, @pageTitle, @browser, @screen, @version, @errors)
                    """, new { id, number, user = me.Id, companyId = scope?.CompanyId, coCode = co.Code, coName = co.Name,
                               branchId = br.Code is null ? null : scope?.BranchId, brCode = br.Code, brName = br.Name, register,
                               kind, severity, title, description, steps = Blank(body.Steps), pagePath = Cut(Blank(body.PagePath), 2000), pageTitle = Cut(Blank(body.PageTitle), 300),
                               browser = Cut(Blank(body.Browser) ?? http.Request.Headers.UserAgent.ToString(), 1000), screen = Cut(Blank(body.Screen), 60),
                               version = AppVersion, errors }, tx);
                await Audit.RecordAsync(c, tx, null, null, me.Id, "feedback", id.ToString(), "created", $"{number} {title}", Audit.Created(
                    ("Number", number), ("Type", KindLabel(kind)), ("Priority", SeverityLabel(severity)), ("Title", title),
                    ("Company", co.Code is null ? null : $"{co.Code} {co.Name}"), ("Branch", br.Code is null ? null : $"{br.Code} {br.Name}"),
                    ("Page", Blank(body.PagePath)), ("Errors in the browser", errors.Length == 0 ? null : errors.Length), ("Status", StatusLabel("new"))));
                return number;
            });
            return Results.Created($"/api/feedback/{id}", new { id, number });
        });

        // Administrators: every report (filters); everyone else: their own (?mine=true is implied).
        api.MapGet("/feedback", async (HttpContext http, Db db, string? status, string? q, bool? mine) =>
        {
            var me = http.CurrentUser();
            var own = mine == true || !me.IsAdmin;
            var term = Blank(q);
            return await db.Platform(async (c, tx) => (await c.QueryAsync<Row>(Select + """
                 where (not @own or f.user_id = @user)
                   and (@status::text is null or (@status = 'open' and f.status in ('new', 'in_progress')) or f.status = @status)
                   and (@term::text is null or f.number ilike '%' || @term || '%' or f.title ilike '%' || @term || '%' or f.description ilike '%' || @term || '%'
                        or coalesce(f.company_code, '') ilike '%' || @term || '%' or coalesce(f.branch_code, '') ilike '%' || @term || '%' or u.display_name ilike '%' || @term || '%')
                 order by f.created_at desc limit 1000
                """, new { own, user = me.Id, status = Blank(status), term }, tx)).ToList());
        });

        api.MapGet("/feedback/{id:guid}", async (HttpContext http, Db db, Guid id) =>
        {
            var me = http.CurrentUser();
            return await db.Platform(async (c, tx) =>
            {
                var row = await FindAsync(c, tx, id, me);
                var comments = await c.QueryAsync<Comment>("""
                    select k.id, k.user_id, u.display_name as user_name, u.is_admin, k.body, k.created_at
                    from feedback_comment k join app_user u on u.id = k.user_id where k.feedback_id = @id order by k.id
                    """, new { id }, tx);
                var files = await c.QueryAsync<FileRow>("""
                    select x.id, x.kind, x.file_name, x.content_type, x.size_bytes, u.display_name as uploaded_by, x.uploaded_at
                    from feedback_file x join app_user u on u.id = x.uploaded_by where x.feedback_id = @id order by x.kind desc, x.uploaded_at
                    """, new { id }, tx);
                var admins = me.IsAdmin
                    ? await c.QueryAsync<(Guid Id, string Name)>("select id, display_name as name from app_user where is_admin and is_active order by display_name", transaction: tx)
                    : [];
                return new { feedback = row, comments, files, assignees = admins.Select(a => new { a.Id, a.Name }), canManage = me.IsAdmin };
            });
        });

        api.MapPut("/feedback/{id:guid}", async (HttpContext http, Db db, Guid id, UpdateInput body) =>
        {
            http.RequireAdmin();
            var me = http.CurrentUser();
            if (!Statuses.Contains(body.Status)) throw new DomainException("Choose the status: new, in progress, fixed or won't fix.");
            if (!Severities.Contains(body.Severity)) throw new DomainException("Choose the priority: blocker, major, normal or minor.");
            await db.Platform(async (c, tx) =>
            {
                var before = await c.QuerySingleOrDefaultAsync<Row>(Select + " where f.id = @id for update of f", new { id }, tx) ?? throw new NotFoundException("Report not found.");
                string? assignee = null;
                if (body.AssigneeId is { } aid)
                    assignee = await c.ExecuteScalarAsync<string?>("select display_name from app_user where id = @aid and is_admin and is_active", new { aid }, tx)
                               ?? throw new DomainException("Assign the report to an active administrator.");
                var resolution = Cut(Blank(body.Resolution), 4000);
                if (body.Status is "fixed" or "wont_fix" && resolution is null && before.Resolution is null && body.Status != before.Status)
                    throw new DomainException(body.Status == "fixed" ? "Say what was fixed (the reporter sees it)." : "Say why it won't be fixed (the reporter sees it).");
                var closed = body.Status is "fixed" or "wont_fix";
                await c.ExecuteAsync("""
                    update feedback set status = @Status, assignee_id = @AssigneeId, severity = @Severity, resolution = coalesce(@resolution, resolution), updated_at = now(),
                      closed_at = case when @closed then coalesce(closed_at, now()) end
                    where id = @id
                    """, new { id, body.Status, body.AssigneeId, body.Severity, resolution, closed }, tx);
                await Audit.RecordAsync(c, tx, null, null, me.Id, "feedback", id.ToString(), "changed", $"{before.Number} {before.Title}",
                [
                    new Audit.FieldChange("Status", StatusLabel(before.Status), StatusLabel(body.Status)),
                    new Audit.FieldChange("Assigned to", before.AssigneeName, assignee),
                    new Audit.FieldChange("Priority", SeverityLabel(before.Severity), SeverityLabel(body.Severity)),
                    new Audit.FieldChange("Resolution", before.Resolution, resolution ?? before.Resolution),
                ]);
                return 0;
            });
            return Results.NoContent();
        });

        api.MapPost("/feedback/{id:guid}/comments", async (HttpContext http, Db db, Guid id, CommentInput body) =>
        {
            var me = http.CurrentUser();
            var text = (body.Body ?? "").Trim();
            if (text.Length == 0) throw new DomainException("Write the comment first.");
            if (text.Length > 8000) throw new DomainException("A comment can be at most 8,000 characters.");
            await db.Platform(async (c, tx) =>
            {
                var row = await FindAsync(c, tx, id, me);
                await c.ExecuteAsync("insert into feedback_comment (feedback_id, user_id, body) values (@id, @user, @text)", new { id, user = me.Id, text }, tx);
                await c.ExecuteAsync("update feedback set updated_at = now() where id = @id", new { id }, tx);
                await Audit.RecordAsync(c, tx, null, null, me.Id, "feedback", id.ToString(), "commented", $"{row.Number} {row.Title}",
                    [new Audit.FieldChange("Comment", null, text.Length > 300 ? text[..297] + "…" : text)]);
                return 0;
            });
            return Results.NoContent();
        });

        // A screenshot (?kind=screenshot) or an attached file; the report must be the user's own (or the user an administrator).
        api.MapPost("/feedback/{id:guid}/files", async (HttpContext http, Db db, Guid id, IFormFile file, string? kind) =>
        {
            var me = http.CurrentUser();
            kind ??= "attachment";
            if (kind is not ("screenshot" or "attachment")) throw new DomainException("A file is a screenshot or an attachment.");
            var name = Path.GetFileName(file.FileName ?? "").Trim();
            if (name.Length is 0 or > 200) throw new DomainException("The file needs a name of up to 200 characters.");
            if (file.Length == 0) throw new DomainException("The file is empty.");
            if (file.Length > MaxFileBytes) throw new DomainException($"The file is {Size(file.Length)}; the limit is 10 MB.");
            var ext = Path.GetExtension(name).ToLowerInvariant();
            if (!Types.TryGetValue(ext, out var contentType))
                throw new DomainException("This file type isn't allowed. Use images (PNG, JPG, WebP), PDF, Excel, Word, CSV or text.");
            await using var ms = new MemoryStream();
            await file.CopyToAsync(ms);
            var bytes = ms.ToArray();
            // Never trust the name: an image is an image, a PDF a PDF, an Office file a zip.
            var image = Pos.ItemImages.Kind(bytes);
            if (contentType.StartsWith("image/", StringComparison.Ordinal) && image is null) throw new DomainException($"{name} isn't a PNG, JPEG or WebP image.");
            if (contentType == "application/pdf" && !(bytes.Length > 4 && bytes[0] == '%' && bytes[1] == 'P' && bytes[2] == 'D' && bytes[3] == 'F')) throw new DomainException($"{name} isn't a PDF.");
            if (ext is ".xlsx" or ".docx" && !(bytes.Length > 4 && bytes[0] == 'P' && bytes[1] == 'K')) throw new DomainException($"{name} isn't an Office file.");
            if (image is not null) contentType = image switch { "png" => "image/png", "webp" => "image/webp", _ => "image/jpeg" };
            if (kind == "screenshot" && image is null) throw new DomainException("A screenshot is an image.");
            var row = await db.Platform((c, tx) => FindAsync(c, tx, id, me));
            // The file is written before its row, outside any transaction; a failed insert leaves a harmless orphan.
            var fileId = Guid.NewGuid();
            var key = $"feedback/{DateTime.UtcNow:yyyy/MM}/{fileId:N}{ext}";
            var path = Path.Combine(root, key);
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            await File.WriteAllBytesAsync(path, bytes);
            var sha = Convert.ToHexStringLower(SHA256.HashData(bytes));
            await db.Platform(async (c, tx) =>
            {
                await c.ExecuteAsync("""
                    insert into feedback_file (id, feedback_id, kind, file_name, content_type, size_bytes, sha256, storage_key, uploaded_by)
                    values (@fileId, @id, @kind, @name, @contentType, @size, @sha, @key, @user)
                    """, new { fileId, id, kind, name, contentType, size = (long)bytes.Length, sha, key, user = me.Id }, tx);
                await Audit.RecordAsync(c, tx, null, null, me.Id, "feedback", id.ToString(), "added", $"{row.Number} {row.Title}",
                    [new Audit.FieldChange(kind == "screenshot" ? "Screenshot" : "File", null, $"{name} ({Size(bytes.Length)})")]);
                return 0;
            });
            return Results.Created($"/api/feedback/files/{fileId}", new { id = fileId });
        }).DisableAntiforgery();

        api.MapGet("/feedback/files/{fileId:guid}", async (HttpContext http, Db db, Guid fileId, bool? download) =>
        {
            var me = http.CurrentUser();
            var f = await db.Platform(async (c, tx) =>
            {
                var x = await c.QuerySingleOrDefaultAsync<(Guid FeedbackId, string FileName, string ContentType, string StorageKey)>(
                    "select feedback_id, file_name, content_type, storage_key from feedback_file where id = @fileId", new { fileId }, tx);
                if (x.StorageKey is null) throw new NotFoundException("File not found.");
                await FindAsync(c, tx, x.FeedbackId, me);
                return x;
            });
            var path = Path.GetFullPath(Path.Combine(root, f.StorageKey));
            if (!path.StartsWith(root, StringComparison.OrdinalIgnoreCase) || !File.Exists(path)) return Results.NotFound();
            http.Response.Headers.XContentTypeOptions = "nosniff";
            var inline = download != true && Inline.Contains(f.ContentType);
            return Results.File(path, f.ContentType, inline ? null : f.FileName, enableRangeProcessing: true);
        });
    }

    /// <summary>The report, if the user may see it (an administrator, or the reporter).</summary>
    private static async Task<Row> FindAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid id, CurrentUser me)
    {
        var row = await c.QuerySingleOrDefaultAsync<Row>(Select + " where f.id = @id", new { id }, tx) ?? throw new NotFoundException("Report not found.");
        if (!me.IsAdmin && row.UserId != me.Id) throw new ForbiddenException("This report belongs to someone else.");
        return row;
    }

    private static string Size(long b) => b < 1024 * 1024 ? $"{Math.Max(1, (b + 512) / 1024)} KB" : $"{b / 1024 / 1024m:0.0} MB";
    private static string? Blank(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();
    private static string? Cut(string? s, int max) => s is null ? null : s.Length <= max ? s : s[..max];
}
