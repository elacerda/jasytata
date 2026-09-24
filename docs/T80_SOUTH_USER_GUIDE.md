# Manual rápido do Jasytata
## Planejamento de novos campos para o T80-South

O **Jasytata** é uma ferramenta para visualizar os campos já existentes de um catálogo do S-PLUS/T80-South e planejar novos apontamentos no céu.

O uso normal é simples:

**carregar catálogo → selecionar uma região → gerar o plano → revisar os novos campos → exportar o CSV.**

---

# 1. Acessando o Jasytata

Abra o Jasytata no navegador.

Endereço atual:

**http://152.84.203.222:8010/**

Ao abrir a página, o perfil padrão deve aparecer como:

**S-PLUS / T80-South**

Para o uso normal do T80-South, **não é necessário alterar esse perfil**.

---

# 2. Carregando o catálogo

Clique em:

**Load catalogue**

e escolha o arquivo CSV com os campos que já existem.

O Jasytata procura automaticamente as colunas de **RA** e **DEC**.

Se ele não conseguir identificá-las sozinho, aparecerá uma tela pedindo:

- **RA column** — coluna com ascensão reta;
- **DEC column** — coluna com declinação;
- **Numeric RA unit** — unidade da RA, quando necessário.

Depois clique em:

**Load mapped catalogue**

O catálogo aparecerá sobre o mapa do céu.

### Para testes

O botão **Load reference** carrega o catálogo de exemplo que acompanha o Jasytata.

Ele é útil para conhecer a ferramenta, mas não substitui o catálogo que será usado no planejamento real.

---

# 3. Navegando pelo mapa

O painel central mostra o céu através do Aladin Lite.

Você pode:

- arrastar o mapa para navegar;
- usar o zoom;
- clicar nos centros dos tiles para ver seus dados;
- ligar e desligar camadas no painel **Map layers**.

Ao clicar em um tile, seus detalhes aparecem no painel da direita.

Os tiles do catálogo original são somente para consulta e **não são modificados pelo Jasytata**.

### Importante

Desligar uma camada em **Map layers** apenas esconde essa camada do mapa.

Os campos continuam sendo considerados pelo planejamento.

---

# 4. Selecionando a região que queremos observar

No painel esquerdo, em **Add tiles**, clique em:

**Select area**

Agora marque no mapa os vértices da região desejada.

1. Clique uma vez para cada vértice.
2. Continue até contornar a região que deseja cobrir.
3. Dê **duplo clique** no último ponto para fechar o polígono.

Quando terminar, aparecerá:

**Selected polygon — finalized**

Se precisar refazer a região, use:

**Redraw polygon**

Para apagar a seleção:

**Clear selection**

---

# 5. Gerando os novos campos

Depois de selecionar a região, clique em:

**Generate plan**

O Jasytata compara a região escolhida com os campos já existentes e calcula quais novos tiles são necessários.

Após alguns instantes será exibida uma **Proposal preview**.

Entre as informações mostradas estão:

- **New tiles** — quantidade de novos campos proposta;
- **Already covered** — fração da região que já estava coberta;
- **Final region coverage** — cobertura estimada após adicionar os novos campos;
- **Remaining uncovered** — parte que ainda ficará sem cobertura;
- **Outside selected area** — cobertura que ficará fora do polígono selecionado.

Também aparecerão no mapa os novos centros propostos.

---

# 6. Revise a proposta antes de aceitar

Este é o passo mais importante.

Observe os novos tiles no mapa e confirme se a distribuição faz sentido para a região que pretende observar.

O Jasytata pode indicar:

### Existing grid extended

O programa encontrou campos existentes próximos e conseguiu continuar a grade observacional a partir deles.

Esse é o comportamento esperado quando há informação suficiente do grid ao redor da região.

### Profile fallback

O programa não encontrou informação suficiente no catálogo próximo para reconstruir com segurança a grade local.

Nesse caso ele usou diretamente a geometria padrão do perfil S-PLUS/T80-South.

**Não significa necessariamente que o plano esteja errado**, mas vale revisar a distribuição dos campos com mais atenção.

---

# 7. Aceitando ou descartando a proposta

Se o resultado estiver correto, clique em:

**Accept proposal**

Os campos passam para a seção:

**Generated proposal**

Se não gostar do resultado, clique em:

**Cancel preview**

Você poderá redesenhar a região ou gerar um novo plano.

Aceitar uma proposta **não altera o catálogo original**.

---

# 8. Removendo campos que não queremos observar

Depois de aceitar uma proposta, você ainda pode ajustar o plano manualmente.

Clique em um dos tiles propostos.

No painel de detalhes aparecerá:

**Disable tile**

Use esse botão para retirar aquele campo do plano.

Um tile desabilitado continua visível como referência, mas **não será incluído no arquivo final**.

Para colocá-lo novamente no plano:

**Enable tile**

Também existem os comandos:

**Restore all**  
Habilita novamente todos os tiles propostos.

**Disable all**  
Desabilita todos os tiles propostos.

**Clear proposal**  
Apaga completamente a proposta atual.

---

# 9. Exportando os campos para observação

Quando estiver satisfeito com o planejamento, vá para:

**Export new tiles**

Escolha o formato das coordenadas:

**Decimal degrees**  
RA e DEC em graus decimais.

ou

**Sexagesimal**  
RA e DEC no formato sexagesimal.

Para o perfil do T80-South, o epoch disponível é:

**2000**

Depois clique em:

**Download new_tiles.csv**

O arquivo gerado contém:

```text
RA,DEC,EPOCH
```

e somente os **novos tiles que estiverem habilitados**.

Exemplo:

```text
RA,DEC,EPOCH
150.50000000,-24.25000000,2000
151.86666667,-24.25000000,2000
```

Esse é o arquivo que deve ser guardado para uso posterior no planejamento da observação.

---

# 10. Adicionando apenas um campo

Nem sempre é necessário gerar uma região inteira.

Para adicionar manualmente um único apontamento:

1. carregue o catálogo;
2. clique em **Single tile**;
3. clique no ponto desejado no mapa;
4. revise a posição;
5. clique em **Accept proposal**.

O campo entrará na proposta da mesma forma que os campos gerados automaticamente.

---

# 11. Importando uma lista de centros

Se você já possui uma lista de coordenadas, use:

**Import centers**

Cole as coordenadas no campo **Paste centers**.

Por exemplo:

```text
RA, DEC
10:03:05, -23:54:31
150.5, -24.25
```

Clique em:

**Validate and preview**

Depois:

**Stage import preview**

Revise os campos no mapa e, se estiverem corretos:

**Accept proposal**

---

# 12. Um cuidado importante: salve seu trabalho

O Jasytata mantém o planejamento atual **apenas na sessão do navegador**.

Isso significa que recarregar a página ou fechar o navegador pode apagar a proposta que estava sendo preparada.

Por isso:

**quando terminar o planejamento, sempre baixe o `new_tiles.csv`.**

Não dependa da página aberta como forma de salvar o trabalho.

---

# Checklist antes de terminar

Antes de usar o arquivo para observação, confira:

- [ ] O perfil mostrado é **S-PLUS / T80-South**.
- [ ] O catálogo correto foi carregado.
- [ ] A região selecionada é a região que deseja observar.
- [ ] Os novos tiles foram revisados visualmente.
- [ ] A cobertura final indicada é adequada ao objetivo.
- [ ] Tiles indesejados foram desabilitados.
- [ ] O formato de coordenadas escolhido é o desejado.
- [ ] O epoch é **2000**.
- [ ] O arquivo **new_tiles.csv** foi baixado.

---

# Resumo em 30 segundos

Para o uso normal:

**1. Load catalogue**  
Carregue o catálogo atual.

**2. Select area**  
Desenhe no céu a região que quer completar.

**3. Generate plan**  
Deixe o Jasytata calcular os novos campos.

**4. Revise o mapa**  
Confira os novos tiles.

**5. Accept proposal**  
Aceite a proposta.

**6. Disable tile**, se necessário  
Retire campos que não deseja observar.

**7. Download new_tiles.csv**  
Salve a lista final.

Pronto.
