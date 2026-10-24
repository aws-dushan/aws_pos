using Microsoft.AspNetCore.Diagnostics;
using Npgsql;

namespace OnePos.Api.Platform;

/// <summary>A business-rule failure with a message the user can act on (HTTP 400).</summary>
public class DomainException(string message) : Exception(message);

public sealed class NotFoundException(string message) : DomainException(message);

public sealed class ForbiddenException(string message) : DomainException(message);

/// <summary>Someone else holds or changed the record (HTTP 409); the message says what to do.</summary>
public sealed class ConflictException(string message) : DomainException(message);

/// <summary>
/// Above the user's limit, but someone allowed can approve it (HTTP 403 with an "approval" object): the till asks a manager — PIN
/// here or a request to approve remotely — and sends the action again with the approval's id (X-Approval-Id).
/// </summary>
public sealed class ApprovalRequiredException(string message, string kind, decimal amount, bool late, Guid? orderId, Guid? shiftId) : DomainException(message)
{
    public object Approval => new { kind, amount, late, orderId, shiftId };
}

public static class ErrorHandling
{
    /// <summary>Turns known failures into { error } JSON with a human message; never leaks stack traces (as AWS One).</summary>
    public static void UseApiErrors(this WebApplication app) => app.UseExceptionHandler(handler => handler.Run(async ctx =>
    {
        var ex = ctx.Features.Get<IExceptionHandlerFeature>()?.Error;
        if (ex is ApprovalRequiredException ar)
        {
            ctx.Response.StatusCode = 403;
            await ctx.Response.WriteAsJsonAsync(new { error = ar.Message, approval = ar.Approval });
            return;
        }
        var (status, message) = ex switch
        {
            NotFoundException e => (404, e.Message),
            ForbiddenException e => (403, e.Message),
            ConflictException e => (409, e.Message),
            DomainException e => (400, e.Message),
            PostgresException { SqlState: PostgresErrorCodes.UniqueViolation } e => (409, Duplicate(e)),
            PostgresException { SqlState: PostgresErrorCodes.ForeignKeyViolation } => (409, "This record is still used elsewhere, so it can't be removed."),
            PostgresException { SqlState: PostgresErrorCodes.CheckViolation } e => (400, Check(e)),
            PostgresException { SqlState: PostgresErrorCodes.NumericValueOutOfRange } => (400, "A number is too large. Check the amounts and quantities."),
            BadHttpRequestException => (400, "The request is not valid."),
            _ => (500, "Something went wrong. The error has been logged."),
        };
        if (status == 500 && ex is not null)
            ctx.RequestServices.GetRequiredService<ILoggerFactory>().CreateLogger("OnePos.Errors").LogError(ex, "Unhandled error on {Path}", ctx.Request.Path);
        ctx.Response.StatusCode = status;
        await ctx.Response.WriteAsJsonAsync(new { error = message });
    }));

    private static string Duplicate(PostgresException e) => e.ConstraintName switch
    {
        "company_code_key" => "A company with this code already exists.",
        "branch_company_id_code_key" => "A branch with this code already exists in the company.",
        "pos_order_paper_ref" => "This slip number was already entered at this branch.",
        "branch_erp_location" => "Another branch already uses this ERP stock location.",
        "app_user_username_key" => "This username is already taken.",
        "role_company_id_name_key" => "A role with this name already exists.",
        "user_company_company_id_pin_lookup_key" => "Another user in this company already has this PIN. Choose a different one.",
        _ => "This record already exists.",
    };

    private static string Check(PostgresException e) => e.ConstraintName switch
    {
        "company_code_check" => "The company code must be 2–10 capital letters or digits.",
        "branch_code_check" => "The branch code must be 2–12 capital letters, digits or dashes.",
        "app_user_username_check" => "The username must be 2–40 lower-case letters, digits, dots, dashes or underscores.",
        _ => "A value is not allowed. Check the form and try again.",
    };
}
