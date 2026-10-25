using System.Data;
using Dapper;
using Npgsql;
using NpgsqlTypes;

namespace OnePos.Api.Data;

/// <summary>
/// Database access (the AWS One pattern). Every unit of work runs in one transaction. Company work sets
/// <c>app.company_id</c> for that transaction, and Postgres Row-Level Security then hides every
/// other company's rows, so a missing WHERE clause can't leak data across companies.
/// </summary>
public sealed class Db(NpgsqlDataSource dataSource)
{
    static Db()
    {
        DefaultTypeMap.MatchNamesWithUnderscores = true;
        SqlMapper.AddTypeHandler(new DateOnlyHandler());
        SqlMapper.AddTypeHandler(new TimeOnlyHandler());
    }

    /// <summary>Platform-level work (companies, users, sign-in) — no company context.</summary>
    public Task<T> Platform<T>(Func<NpgsqlConnection, NpgsqlTransaction, Task<T>> work) => Run(null, work);

    /// <summary>Work inside one company. RLS restricts every query to <paramref name="companyId"/>.</summary>
    public Task<T> Company<T>(Guid companyId, Func<NpgsqlConnection, NpgsqlTransaction, Task<T>> work) => Run(companyId, work);

    private async Task<T> Run<T>(Guid? companyId, Func<NpgsqlConnection, NpgsqlTransaction, Task<T>> work)
    {
        await using var conn = await dataSource.OpenConnectionAsync();
        await using var tx = await conn.BeginTransactionAsync(IsolationLevel.ReadCommitted);
        if (companyId is { } id)
            await conn.ExecuteAsync("select set_config('app.company_id', @id, true)", new { id = id.ToString() }, tx);
        var result = await work(conn, tx);
        await tx.CommitAsync();
        return result;
    }

    private sealed class DateOnlyHandler : SqlMapper.TypeHandler<DateOnly>
    {
        public override void SetValue(IDbDataParameter parameter, DateOnly value)
        {
            parameter.Value = value;
            if (parameter is NpgsqlParameter p) p.NpgsqlDbType = NpgsqlDbType.Date;
        }

        public override DateOnly Parse(object value) => value switch
        {
            DateOnly d => d,
            DateTime dt => DateOnly.FromDateTime(dt),
            _ => throw new DataException($"Cannot convert {value.GetType()} to DateOnly."),
        };
    }

    private sealed class TimeOnlyHandler : SqlMapper.TypeHandler<TimeOnly>
    {
        public override void SetValue(IDbDataParameter parameter, TimeOnly value)
        {
            parameter.Value = value;
            if (parameter is NpgsqlParameter p) p.NpgsqlDbType = NpgsqlDbType.Time;
        }

        public override TimeOnly Parse(object value) => value switch
        {
            TimeOnly t => t,
            TimeSpan ts => TimeOnly.FromTimeSpan(ts),
            _ => throw new DataException($"Cannot convert {value.GetType()} to TimeOnly."),
        };
    }
}
