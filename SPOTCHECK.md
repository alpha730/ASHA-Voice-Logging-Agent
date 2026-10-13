# IMNCI spot-check sheet

Protocol `sick_child_2m_5y` v0.2. Source: IMNCI Chart Booklet for Health Workers (2023), Child Health Division, Ministry of Health & Family Welfare, Government of India.
PDF SHA-256 `97830b803b71a58d93b39f41994943bc5e222905bd8c00f943093228ea3c5d59`, retrieved 2026-10-13 from https://nhmmizoram.org/upload/IMNCI%20Chart%20booklet%20Health%20Worker%202023.pdf.

Every rule below is marked `verified: true` with `source_check.method: ai-compared-to-booklet`. Open the printed page, compare the signs, thresholds, band and follow-up, and write Y or N. Quotes are whitespace-normalised.
If a row is wrong, set its `verified` to false in `imnci-sick-child-2m-5y.json`. If you confirm a row and want it marked as reviewed, set `source_check.method` to `clinician-reviewed` and add `reviewer` and `date`.

Sign ids: `general_danger_sign` is any general danger sign. `fast_breathing` is derived from `respiratory_rate` and age. `wfl_band` values are the MCP card colours: `below_minus_3sd` red, `minus_3_to_minus_2sd` yellow, `at_or_above_minus_2sd` green. `rdt_result` is positive, negative or not_available. `age_months` is the child's age. MUAC is only measured from 6 months, so for a younger child the MUAC parts are skipped. `[(A) OR (B)]` means either; everything joined by AND must hold.

## Check these first

| id | name | band | signs and thresholds the engine uses | follow_up_days | page | exact quote | Matches booklet? (Y/N) |
|---|---|---|---|---|---|---|---|
| fast_breathing (derived) | Fast breathing threshold | — | **Check:** Fast-breathing thresholds by age. age 2–11 months: respiratory_rate ≥ 50/min; age 12–59 months: respiratory_rate ≥ 40/min | — | 09 | "2-11 months ≥ 50/min 12-59 months ≥ 40/min" |  |
| general_danger_sign | GENERAL DANGER SIGN | pink | **Check:** The 'convulsing now' danger sign (look for it in the LOOK list and SIGNS box). any of (unable_to_drink, vomits_everything, convulsions, lethargic_unconscious, convulsing_now) | — | 09 | "A child with any general danger sign needs URGENT attention" |  |
| severe_pneumonia_or_very_severe_disease | SEVERE PNEUMONIA OR VERY SEVERE DISEASE | pink | **Check:** SpO2 below 90. [(any of (general_danger_sign, chest_indrawing)) OR (oxygen_saturation < 90)] | — | 09 | "Chest indrawing or Oxygen saturation < 90%" |  |
| some_dehydration | SOME DEHYDRATION | yellow | **Check:** Some dehydration follow-up. 2 or more of (restless_irritable, sunken_eyes, drinks_eagerly, skin_pinch_slow) | 2 | 10 | "Follow-up after 2 days if not improving." |  |
| severe_acute_malnutrition | SEVERE ACUTE MALNUTRITION | pink | **Check:** Malnutrition: MUAC and oedema. [(wfl_band = below_minus_3sd) OR (age_months ≥ 6 AND muac_cm < 11.5) OR (oedema_both_feet) OR (wfl_band = not_measured AND visible_severe_wasting)] | — | 11 | "WFL <-3 SD score (red color on MCP card)* and/or MUAC <11.5 cm and/or Oedema of both feet" |  |
| moderate_acute_malnutrition | MODERATE ACUTE MALNUTRITION | yellow | **Check:** Malnutrition: MUAC and oedema. [(wfl_band = minus_3_to_minus_2sd) OR (age_months ≥ 6 AND muac_cm ≥ 11.5 AND muac_cm < 12.5)] AND none of (oedema_both_feet) | 30 | 11 | "WFL <-2 SD score (yellow color on MCP card) and/or MUAC 11.5–12.4 cm and No Oedema of both feet" |  |
| no_acute_malnutrition | NO ACUTE MALNUTRITION | green | **Check:** Malnutrition: MUAC and oedema. wfl_band = at_or_above_minus_2sd AND [(age_months < 6) OR (muac_cm ≥ 12.5)] AND none of (oedema_both_feet) | — | 11 | "WFL ≥ -2SD score and MUAC ≥ 12.5 cm and No Oedema of both feet" |  |
| fever_malaria_unlikely | FEVER - MALARIA UNLIKELY | yellow | **Check:** Fever every day for more than 7 days. [(rdt_result = negative) OR (other_cause_of_fever)]; escalate if fever_duration_days > 7 AND fever_daily_over_7_days = true → refer for assessment (fever every day for more than 7 days) | 2 | 10 | "Negative RDT and/or other causes of fever PRESENT" |  |

## Page 09

| id | name | band | signs and thresholds the engine uses | follow_up_days | page | exact quote | Matches booklet? (Y/N) |
|---|---|---|---|---|---|---|---|
| general_danger_sign | GENERAL DANGER SIGN | pink | any of (unable_to_drink, vomits_everything, convulsions, lethargic_unconscious, convulsing_now) | — | 09 | "A child with any general danger sign needs URGENT attention" |  |
| fast_breathing (derived) | Fast breathing threshold | — | age 2–11 months: respiratory_rate ≥ 50/min; age 12–59 months: respiratory_rate ≥ 40/min | — | 09 | "2-11 months ≥ 50/min 12-59 months ≥ 40/min" |  |
| severe_pneumonia_or_very_severe_disease | SEVERE PNEUMONIA OR VERY SEVERE DISEASE | pink | [(any of (general_danger_sign, chest_indrawing)) OR (oxygen_saturation < 90)] | — | 09 | "Chest indrawing or Oxygen saturation < 90%" |  |
| pneumonia | PNEUMONIA | yellow | fast_breathing AND none of (general_danger_sign, chest_indrawing) AND oxygen_saturation ≥ 90 | 2 | 09 | "Give amoxycillin for 5 days." |  |
| no_pneumonia_cough_or_cold | NO PNEUMONIA: COUGH OR COLD | green | none of (general_danger_sign, chest_indrawing, fast_breathing) AND oxygen_saturation ≥ 90; escalate if cough_duration_days > 14 → refer for assessment (cough for more than 14 days) | 5 | 09 | "If coughing for more than 14 days, refer for assessment" |  |

## Page 10

| id | name | band | signs and thresholds the engine uses | follow_up_days | page | exact quote | Matches booklet? (Y/N) |
|---|---|---|---|---|---|---|---|
| dehydration escalation | Escalation on every dehydration row | → refer | [(blood_in_stool = true) OR (diarrhoea_duration_days ≥ 14)] → refer to hospital (blood in stool or diarrhoea 14 days or more) | — | 10 | "If blood in stool or diarrhoea ≥ 14 days, refer to hospital." |  |
| severe_dehydration | SEVERE DEHYDRATION | pink | 2 or more of (lethargic_unconscious, sunken_eyes, drinks_poorly, skin_pinch_very_slow) | — | 10 | "Refer URGENTLY to hospital with mother giving frequent sips of ORS on the way." |  |
| some_dehydration | SOME DEHYDRATION | yellow | 2 or more of (restless_irritable, sunken_eyes, drinks_eagerly, skin_pinch_slow) | 2 | 10 | "Follow-up after 2 days if not improving." |  |
| no_dehydration | NO DEHYDRATION | green | otherwise (no row above it matched) | 5 | 10 | "Not enough signs to classify as some or severe dehydration." |  |
| very_severe_febrile_disease | VERY SEVERE FEBRILE DISEASE | pink | any of (general_danger_sign, stiff_neck) | — | 10 | "Any general danger sign or Stiff Neck" |  |
| malaria | MALARIA/ SUSPECTED MALARIA | yellow | [(rdt_result = positive) OR (rdt_result = not_available AND none of (other_cause_of_fever))] | 2 | 10 | "Positive RDT or RDT not available and no other obvious cause of fever" |  |
| fever_malaria_unlikely | FEVER - MALARIA UNLIKELY | yellow | [(rdt_result = negative) OR (other_cause_of_fever)]; escalate if fever_duration_days > 7 AND fever_daily_over_7_days = true → refer for assessment (fever every day for more than 7 days) | 2 | 10 | "Negative RDT and/or other causes of fever PRESENT" |  |

## Page 11

| id | name | band | signs and thresholds the engine uses | follow_up_days | page | exact quote | Matches booklet? (Y/N) |
|---|---|---|---|---|---|---|---|
| severe_acute_malnutrition | SEVERE ACUTE MALNUTRITION | pink | [(wfl_band = below_minus_3sd) OR (age_months ≥ 6 AND muac_cm < 11.5) OR (oedema_both_feet) OR (wfl_band = not_measured AND visible_severe_wasting)] | — | 11 | "WFL <-3 SD score (red color on MCP card)* and/or MUAC <11.5 cm and/or Oedema of both feet" |  |
| moderate_acute_malnutrition | MODERATE ACUTE MALNUTRITION | yellow | [(wfl_band = minus_3_to_minus_2sd) OR (age_months ≥ 6 AND muac_cm ≥ 11.5 AND muac_cm < 12.5)] AND none of (oedema_both_feet) | 30 | 11 | "WFL <-2 SD score (yellow color on MCP card) and/or MUAC 11.5–12.4 cm and No Oedema of both feet" |  |
| no_acute_malnutrition | NO ACUTE MALNUTRITION | green | wfl_band = at_or_above_minus_2sd AND [(age_months < 6) OR (muac_cm ≥ 12.5)] AND none of (oedema_both_feet) | — | 11 | "WFL ≥ -2SD score and MUAC ≥ 12.5 cm and No Oedema of both feet" |  |
| severe_anaemia | SEVERE ANEMIA | pink | palmar_pallor = severe | — | 11 | "Severe palmar pallor" |  |
| anaemia | ANEMIA | yellow | palmar_pallor = some | 14 | 11 | "Give iron folic acid therapy for 14 days" |  |
| no_anaemia | NO ANEMIA | green | palmar_pallor = none | — | 11 | "Give prophylactic iron folic acid if child 6 months or older." |  |

18 verified rules. Rules that are not verified are not listed; the retired ear and measles rows are in `retired_rules` in the JSON.
