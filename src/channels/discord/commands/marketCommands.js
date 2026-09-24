import { SlashCommandBuilder } from "discord.js";

import { addShareOption, addShareOptionToSubcommand } from "./shared.js";

export function buildEtfScreenCommandJson() {
  return new SlashCommandBuilder()
    .setName("etfscreen")
    .setDescription("ETF DB를 다양한 관점으로 빠르게 스크리닝한다냥.")
    .addSubcommand((subcommand) =>
      addShareOptionToSubcommand(
        subcommand
          .setName("list")
          .setDescription("ETF 스크리닝 결과를 본다냥.")
          .addStringOption((option) =>
            option
              .setName("category")
              .setDescription("보고 싶은 분류를 골라달라냥.")
              .setRequired(true)
              .addChoices(
                { name: "개요", value: "overview" },
                { name: "종합 우량", value: "composite" },
                { name: "저평가 (PER·PBR·PSR)", value: "undervalued" },
                { name: "저평가 (PER·PBR·EV/EBITDA·P/FCF)", value: "undervalued_cashflow" },
                { name: "이상치", value: "outlier" },
                { name: "현금흐름 좋음", value: "cashflow_good" },
                {
                  name: "현금흐름·CAPEX 악화",
                  value: "cashflow_capex_deterioration",
                },
                { name: "모멘텀 진행", value: "momentum" },
                { name: "모멘텀 악화", value: "momentum_deterioration" },
              ),
          )
          .addBooleanOption((option) =>
            option
              .setName("reverse")
              .setDescription("역순으로 본다냥. 모멘텀은 완전한 반대가 아니라 약한 반대 방향 의미다냥."),
          )
          .addIntegerOption((option) =>
            option
              .setName("limit")
              .setDescription("보고 싶은 개수다냥. 기본 5개다냥. (개요 기본=1개)")
              .setMinValue(1)
              .setMaxValue(10),
          ),
      ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("criteria")
        .setDescription("ETF 스크린 criteria 전체 또는 개별 항목을 조회·저장한다냥.")
        .addStringOption((option) =>
          option
            .setName("category")
            .setDescription("비우면 전체 JSON, 고르면 개별 카테고리다냥.")
            .addChoices(
              { name: "종합 우량", value: "composite" },
              { name: "저평가 (PER·PBR·PSR)", value: "undervalued" },
              { name: "저평가 (PER·PBR·EV/EBITDA·P/FCF)", value: "undervalued_cashflow" },
              { name: "이상치", value: "outlier" },
              { name: "현금흐름 좋음", value: "cashflow_good" },
              {
                name: "현금흐름·CAPEX 악화",
                value: "cashflow_capex_deterioration",
              },
              { name: "모멘텀 진행", value: "momentum" },
              { name: "모멘텀 악화", value: "momentum_deterioration" },
            ),
        )
        .addBooleanOption((option) =>
          option
            .setName("save")
            .setDescription("ON이면 아래 criteria JSON을 저장한다냥."),
        )
        .addStringOption((option) =>
          option
            .setName("criteria")
            .setDescription("저장할 criteria JSON이다냥. save=true일 때만 쓴다냥.")
            .setMaxLength(4000),
        ),
    )
    .toJSON();
}

export function buildEtfLookupCommandJson() {
  return addShareOption(
    new SlashCommandBuilder()
      .setName("etf")
      .setDescription("직접 수집한 ETF 구성종목·발행좌수·지수·자금흐름을 보여준다냥.")
      .addStringOption((option) =>
        option
          .setName("symbol")
          .setDescription("ETF ticker, ISIN 또는 share class ID")
          .setRequired(true)
          .setMaxLength(64),
      ),
  ).toJSON();
}

export function buildStockLookupCommandJson() {
  return addShareOption(
    new SlashCommandBuilder()
      .setName("stock")
      .setDescription("특정 기업의 캐시된 재무를 보여준다냥.")
      .addStringOption((option) =>
        option
          .setName("symbol")
          .setDescription("자동완성: 회사명 | 거래소 | 최대매출국가 | 산업")
          .setRequired(true)
          .setAutocomplete(true)
          .setMaxLength(64),
      ),
  ).toJSON();
}

export function buildStockScreenCommandJson() {
  return new SlashCommandBuilder()
    .setName("stockscreen")
    .setDescription("주식 유니버스를 다양한 관점으로 빠르게 스크리닝한다냥.")
    .addSubcommand((subcommand) =>
      addShareOptionToSubcommand(
        subcommand
          .setName("list")
          .setDescription("전역 랭킹 형태로 종목을 본다냥.")
          .addStringOption((option) =>
            option
              .setName("category")
              .setDescription("보고 싶은 분류를 골라달라냥.")
              .setRequired(true)
              .addChoices(
                { name: "개요", value: "overview" },
                { name: "종합 우량", value: "composite" },
                { name: "ETF 포함 수", value: "etf_included_count" },
                { name: "시가총액 대비 ETF 보유금액 총규모", value: "etf_total_exposure" },
                { name: "시가총액 대비 ETF 유입금액 1개월", value: "etf_fund_flow_to_market_cap_1m" },
                { name: "시가총액 대비 ETF 유입금액 3개월", value: "etf_fund_flow_to_market_cap_3m" },
                { name: "저평가 (PER·PBR·EV/EBITDA·P/FCF)", value: "undervalued" },
                { name: "저평가 (PER·PBR·PSR)", value: "undervalued_psr" },
                { name: "이상치", value: "outlier" },
                { name: "현금흐름 좋음", value: "cashflow_good" },
                {
                  name: "현금흐름·CAPEX 악화",
                  value: "cashflow_capex_deterioration",
                },
                { name: "모멘텀 진행", value: "momentum" },
                { name: "모멘텀 악화", value: "momentum_deterioration" },
              ),
          )
          .addBooleanOption((option) =>
            option
              .setName("reverse")
              .setDescription("역순으로 본다냥. 모멘텀은 완전한 반대가 아니라 약한 반대 방향 의미다냥."),
          )
          .addIntegerOption((option) =>
            option
              .setName("limit")
              .setDescription("전역 랭킹에서 보고 싶은 개수다냥. 기본 5개다냥. (개요 기본=1개)")
              .setMinValue(1)
              .setMaxValue(10),
          )
          .addStringOption((option) =>
            option
              .setName("industries")
              .setDescription("특정 산업만 보려면 쉼표로 구분해 적어달라냥.")
              .setAutocomplete(true)
              .setMaxLength(500),
          )
          .addBooleanOption((option) =>
            option
              .setName("us-only")
              .setDescription("미국 거래소 종목만 미리 걸러서 평가한다냥. 기본 ON이다냥."),
          ),
      ),
    )
    .addSubcommand((subcommand) =>
      addShareOptionToSubcommand(
        subcommand
          .setName("industry-only")
          .setDescription("산업 자체를 시총가중 평균 순위로 본다냥.")
          .addStringOption((option) =>
            option
              .setName("category")
              .setDescription("보고 싶은 분류를 골라달라냥.")
              .setRequired(true)
              .addChoices(
                { name: "개요", value: "overview" },
                { name: "종합 우량", value: "composite" },
                { name: "ETF 포함 수", value: "etf_included_count" },
                { name: "시가총액 대비 ETF 보유금액 총규모", value: "etf_total_exposure" },
                { name: "시가총액 대비 ETF 유입금액 1개월", value: "etf_fund_flow_to_market_cap_1m" },
                { name: "시가총액 대비 ETF 유입금액 3개월", value: "etf_fund_flow_to_market_cap_3m" },
                { name: "저평가 (PER·PBR·EV/EBITDA·P/FCF)", value: "undervalued" },
                { name: "저평가 (PER·PBR·PSR)", value: "undervalued_psr" },
                { name: "이상치", value: "outlier" },
                { name: "현금흐름 좋음", value: "cashflow_good" },
                {
                  name: "현금흐름·CAPEX 악화",
                  value: "cashflow_capex_deterioration",
                },
                { name: "모멘텀 진행", value: "momentum" },
                { name: "모멘텀 악화", value: "momentum_deterioration" },
              ),
          )
          .addBooleanOption((option) =>
            option
              .setName("reverse")
              .setDescription("역순으로 본다냥. 모멘텀은 완전한 반대가 아니라 약한 반대 방향 의미다냥."),
          )
          .addStringOption((option) =>
            option
              .setName("industries")
              .setDescription("특정 산업만 보려면 쉼표로 구분해 적어달라냥.")
              .setAutocomplete(true)
              .setMaxLength(500),
          )
          .addBooleanOption((option) =>
            option
              .setName("us-only")
              .setDescription("미국 거래소 종목만 미리 걸러서 평가한다냥. 기본 ON이다냥."),
          )
          .addIntegerOption((option) =>
            option
              .setName("max_industries")
              .setDescription("보여줄 산업 수다냥. 기본 5개, 최대 40개다냥. (개요 기본=3개)")
              .setMinValue(1)
              .setMaxValue(40),
          ),
      ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("criteria")
        .setDescription("주식 스크린 criteria 전체 또는 개별 항목을 조회·저장한다냥.")
        .addStringOption((option) =>
          option
            .setName("category")
            .setDescription("비우면 전체 JSON, 고르면 개별 카테고리다냥.")
            .addChoices(
              { name: "종합 우량", value: "composite" },
              { name: "ETF 포함 수", value: "etf_included_count" },
              { name: "시가총액 대비 ETF 보유금액 총규모", value: "etf_total_exposure" },
              { name: "시가총액 대비 ETF 유입금액 1개월", value: "etf_fund_flow_to_market_cap_1m" },
              { name: "시가총액 대비 ETF 유입금액 3개월", value: "etf_fund_flow_to_market_cap_3m" },
              { name: "저평가 (PER·PBR·EV/EBITDA·P/FCF)", value: "undervalued" },
              { name: "저평가 (PER·PBR·PSR)", value: "undervalued_psr" },
              { name: "이상치", value: "outlier" },
              { name: "현금흐름 좋음", value: "cashflow_good" },
              {
                name: "현금흐름·CAPEX 악화",
                value: "cashflow_capex_deterioration",
              },
              { name: "모멘텀 진행", value: "momentum" },
              { name: "모멘텀 악화", value: "momentum_deterioration" },
            ),
        )
        .addBooleanOption((option) =>
          option
            .setName("save")
            .setDescription("ON이면 아래 criteria JSON을 저장한다냥."),
        )
        .addStringOption((option) =>
          option
            .setName("criteria")
            .setDescription("저장할 criteria JSON이다냥. save=true일 때만 쓴다냥.")
            .setMaxLength(4000),
        ),
    )
    .addSubcommand((subcommand) =>
      addShareOptionToSubcommand(
        subcommand
          .setName("industry")
          .setDescription("산업별 대표 종목 묶음으로 본다냥.")
          .addStringOption((option) =>
            option
              .setName("category")
              .setDescription("보고 싶은 분류를 골라달라냥.")
              .setRequired(true)
              .addChoices(
                { name: "개요", value: "overview" },
                { name: "종합 우량", value: "composite" },
                { name: "ETF 포함 수", value: "etf_included_count" },
                { name: "시가총액 대비 ETF 보유금액 총규모", value: "etf_total_exposure" },
                { name: "시가총액 대비 ETF 유입금액 1개월", value: "etf_fund_flow_to_market_cap_1m" },
                { name: "시가총액 대비 ETF 유입금액 3개월", value: "etf_fund_flow_to_market_cap_3m" },
                { name: "저평가 (PER·PBR·EV/EBITDA·P/FCF)", value: "undervalued" },
                { name: "저평가 (PER·PBR·PSR)", value: "undervalued_psr" },
                { name: "이상치", value: "outlier" },
                { name: "현금흐름 좋음", value: "cashflow_good" },
                {
                  name: "현금흐름·CAPEX 악화",
                  value: "cashflow_capex_deterioration",
                },
                { name: "모멘텀 진행", value: "momentum" },
                { name: "모멘텀 악화", value: "momentum_deterioration" },
              ),
          )
          .addBooleanOption((option) =>
            option
              .setName("reverse")
              .setDescription("역순으로 본다냥. 모멘텀은 완전한 반대가 아니라 약한 반대 방향 의미다냥."),
          )
          .addStringOption((option) =>
            option
              .setName("industries")
              .setDescription("특정 산업만 보려면 쉼표로 구분해 적어달라냥.")
              .setAutocomplete(true)
              .setMaxLength(500),
          )
          .addBooleanOption((option) =>
            option
              .setName("us-only")
              .setDescription("미국 거래소 종목만 미리 걸러서 평가한다냥. 기본 ON이다냥."),
          )
          .addIntegerOption((option) =>
            option
              .setName("per_industry_limit")
              .setDescription("산업별로 보여줄 개수다냥. 기본 2개다냥. (개요 기본=1개)")
              .setMinValue(1)
              .setMaxValue(5),
          )
          .addIntegerOption((option) =>
            option
              .setName("max_industries")
              .setDescription("보여줄 산업 수다냥. 기본 5개, 최대 40개다냥. (개요 기본=3개)")
              .setMinValue(1)
              .setMaxValue(40),
          ),
      ),
    )
    .toJSON();
}
