import { internalMarketStorage } from "./provider.js";
import { fetchDirectEtfLookup } from "../local/etfGateway.js";

export async function fetchEtfScreen({
  category,
  limit,
  criteria,
  reverse,
}) {
  return internalMarketStorage.buildEtfScreenMessage({
    category,
    limit,
    criteria,
    reverse,
  });
}

export async function fetchStockScreen({
  category,
  limit,
  criteria,
  reverse,
  industryHighlights,
  industryOnly,
  industries,
  usOnly,
  perIndustryLimit,
  maxIndustries,
}) {
  return internalMarketStorage.buildStockScreenMessage({
    category,
    limit,
    criteria,
    reverse,
    industryHighlights,
    industryOnly,
    industries,
    usOnly,
    perIndustryLimit,
    maxIndustries,
  });
}

export async function fetchEtfLookup({ symbol }) {
  return fetchDirectEtfLookup({ symbol });
}

export async function fetchStockLookup({ symbol }) {
  return internalMarketStorage.buildStockLookupMessage(symbol);
}

export async function fetchSymbolAutocomplete({ dataset, query }) {
  return internalMarketStorage.buildSymbolAutocompleteChoices({ dataset, query });
}

export async function fetchIndustryAutocomplete({ query }) {
  return internalMarketStorage.buildIndustryAutocompleteChoices({ query });
}

export async function resolveReportQuestionScope({
  scopeMode,
  targetSymbols,
  targetCompanyQueries,
  targetIndustries,
}) {
  return internalMarketStorage.resolveReportQuestionScope({
    scopeMode,
    targetSymbols,
    targetCompanyQueries,
    targetIndustries,
  });
}
