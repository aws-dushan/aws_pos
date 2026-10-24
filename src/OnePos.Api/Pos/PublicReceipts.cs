using Dapper;
using OnePos.Api.Data;

namespace OnePos.Api.Pos;

/// <summary>
/// The digital receipt (REQ PAY-05): the page a receipt's QR code opens, without signing in. The link's long random token is
/// the only key; the receipt leaves out payment references and kitchen tickets.
/// </summary>
public static class PublicReceipts
{
    public static void Map(WebApplication app)
    {
        app.MapGet("/api/public/receipts/{token}", async (string token, Db db) =>
        {
            if (token.Length is < 16 or > 40) return Results.NotFound();
            var link = await db.Platform((c, tx) => c.QuerySingleOrDefaultAsync<(Guid CompanyId, Guid OrderId)>(
                "select company_id, order_id from receipt_link where token = @token", new { token }, tx));
            if (link.CompanyId == Guid.Empty) return Results.NotFound();
            var receipt = await db.Company(link.CompanyId, (c, tx) => Orders.ReceiptAsync(c, tx, link.OrderId, link.CompanyId, publicView: true));
            return Results.Ok(receipt);
        }).AllowAnonymous();
    }
}
